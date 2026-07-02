/* ── v1 → v2 migration: lift the legacy name-keyed stores into `eva` ─────
   Sources (READ-ONLY — old keys are kept for 30 days, then cleaned):
     • studentDb global (hsp_sdb)          → eva.students  (stable ids)
     • courseConfig global (hsp_course)    → eva.config    (groups/hospitals/schedule)
     • header settings + roster            → eva.config.settings / eva.config.roster
     • history global (daily + cyc_* keys) → eva.evaluations
   Id rules:
     studentId  'st<num>' from the university number column when unique,
                else a deterministic slug of the name. Names found in
                history but not in the registry are auto-created with
                needsReview:true — never guessed, never dropped.
     evalId     daily:  <dateISO>_<shift>_<hospitalId>_<studentId>
                legacy cycle (no real date): cycd<N>_<groupId>_<hospitalId>_<studentId>
                (kept unique per rotation day; carries legacyCycleDay:N)
   The migration is idempotent: existing eva.evaluations records are never
   overwritten (skip), so re-runs and multi-device runs converge.        */
(function () {
  'use strict';

  function slug(name) {
    // deterministic, collision-resistant enough for a class roster
    var s = String(name || '').trim();
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return 'stn' + h.toString(36);
  }
  function sanitizeId(s) { return String(s || '').replace(/[.#$\[\]\/\s]+/g, '-').replace(/^-+|-+$/g, ''); }

  function buildStudents(report) {
    var byName = {}, usedIds = {};
    var rows = (window.studentDb && Array.isArray(studentDb)) ? studentDb : [];
    rows.forEach(function (r) {
      var nm = String((r && r.name) || '').trim(); if (!nm) return;
      var id = null;
      var num = String((r && r.num) || '').trim();
      if (num && !usedIds['st' + num]) id = 'st' + sanitizeId(num);
      if (!id || usedIds[id]) id = slug(nm);
      if (usedIds[id]) return; // exact duplicate row
      usedIds[id] = 1;
      byName[nm] = id;
      window.eva.students[id] = {
        id: id, name: nm, nameAr: nm,
        email: String(r.email || ''), group: String(r.group || ''),
        area: String(r.area || ''), type: String(r.type || ''),
        active: true, needsReview: false
      };
      report.students++;
    });
    return {
      resolve: function (nm) {
        nm = String(nm || '').trim(); if (!nm) return null;
        if (byName[nm]) return byName[nm];
        var id = slug(nm);
        if (!window.eva.students[id]) {
          window.eva.students[id] = { id: id, name: nm, nameAr: nm, email: '', group: '',
                                      area: '', type: '', active: true, needsReview: true };
          report.autoCreated++;
        }
        byName[nm] = id;
        return id;
      }
    };
  }

  function buildConfig() {
    var cfg = window.eva.config;
    var cc = (typeof courseConfig !== 'undefined' && courseConfig) ? courseConfig : null;
    if (cc) {
      cfg.groups = JSON.parse(JSON.stringify(cc.groups || []));
      cfg.hospitals = JSON.parse(JSON.stringify(cc.hospitals || []));
      cfg.schedule = JSON.parse(JSON.stringify(cc.schedule || []));
      cfg.courseName = cc.name || '';
      cfg.startDate = cc.startDate || '';
      cfg.daysPerWeek = cc.daysPerWeek || 2;
      cfg.weeksPerStation = cc.weeksPerStation || 2;
    }
    cfg.cycleLengthDays = 4;
    try {
      cfg.settings = {
        hospitalName: document.getElementById('hName') ? document.getElementById('hName').value : '',
        hospitalNo: document.getElementById('hNo') ? document.getElementById('hNo').value : '',
        supervisorName: document.getElementById('supName') ? document.getElementById('supName').value : ''
      };
    } catch (e) { cfg.settings = {}; }
    if (window.roster && Array.isArray(roster) && roster.length) {
      cfg.roster = JSON.parse(JSON.stringify(roster));
    }
  }

  function hospitalId(name) {
    var nm = String(name || '').trim();
    if (!nm) return 'h_unknown';
    var hs = window.eva.config.hospitals || [];
    for (var i = 0; i < hs.length; i++) if (hs[i].name === nm) return hs[i].id;
    return 'h_' + sanitizeId(nm);
  }
  function groupIdFor(groupNum, typeAr) {
    var shift = (typeAr && typeAr.indexOf('مسائ') >= 0) ? 'evening' : 'morning';
    var gs = window.eva.config.groups || [];
    for (var i = 0; i < gs.length; i++) {
      if (String(gs[i].number) === String(groupNum) && gs[i].shift === shift) return gs[i].id;
    }
    return 'legacy_g' + sanitizeId(groupNum) + '_' + (shift === 'evening' ? 'e' : 'm');
  }

  function recBase(old, sess) {
    return {
      attendance: old.attendance || null,
      attendanceTime: old.attendanceTime || null,
      scores: old.scores || {},
      total: (typeof old.total === 'number') ? old.total :
             (typeof old.manualTotal === 'number' ? Math.min(15, old.manualTotal) : null),
      manualTotal: (typeof old.manualTotal === 'number') ? old.manualTotal : undefined,
      evaluated: !!old.evaluated,
      notes: old.notes || '',
      paperDelivered: (old.paperDelivered === true || old.paperDelivered === false) ? old.paperDelivered : null,
      entrustment: null,
      feedback: { well: '', improve: '' },
      cases: [],
      evaluatorUid: null, evaluatorName: null,
      signature: null,
      locked: !!old.locked,
      legacy: true,
      createdAt: (sess && sess.__savedAt__) || Date.now(),
      updatedAt: (sess && sess.__savedAt__) || Date.now(),
      rev: 1
    };
  }

  function hasContent(r) {
    return !!(r && (r.attendance || r.evaluated || (typeof r.total === 'number') ||
             (typeof r.manualTotal === 'number') ||
             (r.scores && Object.keys(r.scores).length) ||
             (r.notes && String(r.notes).trim()) ||
             r.paperDelivered === true || r.paperDelivered === false));
  }

  window.migrateV1toV2 = function () {
    if (window.eva.meta.v1Migrated) return null;
    var report = { students: 0, autoCreated: 0, evals: 0, skipped: 0, nameless: 0 };
    try {
      var resolver = buildStudents(report);
      buildConfig();

      // The app's `history` global lives in the main inline script; read it
      // through the explicit accessor it exposes. If the accessor is not
      // wired, BAIL WITHOUT setting the migrated flag (nothing was lifted).
      if (typeof window.__getAppHistory !== 'function') return report;
      var H = window.__getAppHistory() || {};

      Object.keys(H).forEach(function (key) {
        var sess = H[key]; if (!sess || typeof sess !== 'object') return;
        var daily = key.match(/^(\d{4}-\d{2}-\d{2})_(morning|evening)$/);
        var cyc = (key.indexOf('cyc_') === 0) ? (function () {
          var s = key.replace(/_morning$/, '').slice(4);
          var hosp = ''; var hIdx = s.indexOf('_h_');
          if (hIdx >= 0) { hosp = s.slice(hIdx + 3); s = s.slice(0, hIdx); }
          var dm = s.match(/_d(\d+)$/); if (!dm) return null;
          var day = parseInt(dm[1], 10);
          s = s.slice(0, s.length - dm[0].length);
          var us = s.indexOf('_');
          return { group: us >= 0 ? s.slice(0, us) : s, type: us >= 0 ? s.slice(us + 1) : '', day: day, hospital: hosp };
        })() : null;
        if (!daily && !cyc) return;

        var names = Array.isArray(sess.__names__) ? sess.__names__ : [];
        Object.keys(sess).forEach(function (idx) {
          if (!/^\d+$/.test(idx)) return;
          var old = sess[idx];
          if (!hasContent(old)) return;
          var nm = String((old && old.name) || names[parseInt(idx, 10)] || '').trim();
          if (!nm) { report.nameless++; return; } // unattributable — stays in legacy history
          var sid = resolver.resolve(nm);
          var evalId, rec = recBase(old, sess);
          if (daily) {
            var hosp = sess.__hospital__ || (window.eva.config.settings && window.eva.config.settings.hospitalName) || '';
            evalId = daily[1] + '_' + daily[2] + '_' + hospitalId(hosp) + '_' + sid;
            rec.dateISO = daily[1];
            rec.groupId = daily[2]; // shift-as-group until course groups take over
            rec.hospitalId = hospitalId(hosp);
            if (sess.__block__) rec.block = sess.__block__;
            if (sess.__dayNo__) rec.legacyCycleDay = parseInt(sess.__dayNo__, 10) || null;
            if (sess.__unit__) rec.unit = sess.__unit__;
          } else {
            var gid = groupIdFor(cyc.group, cyc.type);
            var hid = cyc.hospital ? hospitalId(cyc.hospital) : 'h_unknown';
            evalId = 'cycd' + cyc.day + '_' + gid + '_' + hid + '_' + sid;
            rec.dateISO = null; // legacy rotation day — no calendar date recorded
            rec.groupId = gid;
            rec.hospitalId = hid;
            rec.legacyCycleDay = cyc.day;
          }
          rec.studentId = sid;
          if (window.eva.evaluations[evalId]) { report.skipped++; return; } // idempotent
          window.eva.evaluations[evalId] = rec;
          report.evals++;
        });
      });

      // persist everything in one pass (audit: a single summary entry)
      window.Store.update('students', function () { return window.eva.students; },
        { action: 'migrate:v1:students', noSync: true, silent: true, noAudit: true });
      window.Store.update('config', function () { return window.eva.config; },
        { action: 'migrate:v1:config', noSync: true, silent: true, noAudit: true });
      window.Store.update('evaluations', function () { return window.eva.evaluations; },
        { action: 'migrate:v1:evaluations', noSync: true, silent: true, noAudit: true });
      window.eva.meta.v1Migrated = Date.now();
      window.eva.meta.lastMigration = 'v1->v2';
      window.eva.meta.v1KeepUntil = Date.now() + 30 * 86400000; // old keys read-only for 30 days
      window.Store.update('meta', function () { return window.eva.meta; },
        { action: 'migrate:v1:done (' + report.evals + ' eval, ' + report.students + ' students, ' +
                  report.autoCreated + ' auto-created, ' + report.skipped + ' skipped)',
          noSync: true });
      window.bus.emit('students:changed', {});
      window.bus.emit('config:changed', {});
      window.bus.emit('evaluation:saved', { migrated: true });
      return report;
    } catch (e) {
      if (window.reportIssue) reportIssue('migrateV1toV2', e);
      return report;
    }
  };
})();
