/* ── Strangler bridge: classic history writes → canonical v2 Store ───────
   The classic UI still drives the screens (tested, working). Every classic
   save also flows here into eva.evaluations via Store.update, so the v2
   store stays live, the audit log + sync outbox fill on every mutation, and
   the bus fires — letting new/subscribed surfaces update with no cross-tab
   coupling. This is the read-side unification path for later phases: once a
   tab reads from Selectors, its classic writes are already mirrored here.

   Exposed: window.bridgeSession(sessionKey, sessionObj) — call after a
   classic saveDay writes history[sessionKey]. Idempotent per (evalId,rev):
   it re-derives the record and updates only when content changed.          */
(function () {
  'use strict';

  function slug(name) {
    var s = String(name || '').trim(), h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return 'stn' + h.toString(36);
  }
  function sanitize(s) { return String(s || '').replace(/[.#$\[\]\/\s]+/g, '-').replace(/^-+|-+$/g, ''); }

  function resolveStudentId(name) {
    var nm = String(name || '').trim(); if (!nm) return null;
    // exact match in the registry
    var ids = Object.keys(window.eva.students);
    for (var i = 0; i < ids.length; i++) if (window.eva.students[ids[i]].name === nm) return ids[i];
    // auto-create (flagged for review) — never drop a graded student
    var id = slug(nm);
    if (!window.eva.students[id]) {
      window.Store.update('students.' + id, function () {
        return { id: id, name: nm, nameAr: nm, email: '', group: '', area: '', type: '',
                 active: true, needsReview: true };
      }, { action: 'bridge:autoStudent', event: 'students:changed', noSync: false });
    }
    return id;
  }

  function hospitalId(name) {
    var nm = String(name || '').trim(); if (!nm) return 'h_unknown';
    var hs = window.eva.config.hospitals || [];
    for (var i = 0; i < hs.length; i++) if (hs[i].name === nm) return hs[i].id;
    return 'h_' + sanitize(nm);
  }
  function groupIdFor(groupNum, typeAr) {
    var shift = (typeAr && String(typeAr).indexOf('مسائ') >= 0) ? 'evening' : 'morning';
    var gs = window.eva.config.groups || [];
    for (var i = 0; i < gs.length; i++) if (String(gs[i].number) === String(groupNum) && gs[i].shift === shift) return gs[i].id;
    return 'legacy_g' + sanitize(groupNum) + '_' + (shift === 'evening' ? 'e' : 'm');
  }

  function parseKey(key) {
    var daily = key.match(/^(\d{4}-\d{2}-\d{2})_(morning|evening)$/);
    if (daily) return { kind: 'daily', dateISO: daily[1], shift: daily[2] };
    if (key.indexOf('cyc_') === 0) {
      var s = key.replace(/_morning$/, '').slice(4);
      var hosp = ''; var hIdx = s.indexOf('_h_');
      if (hIdx >= 0) { hosp = s.slice(hIdx + 3); s = s.slice(0, hIdx); }
      var dm = s.match(/_d(\d+)$/); if (!dm) return null;
      var day = parseInt(dm[1], 10);
      s = s.slice(0, s.length - dm[0].length);
      var us = s.indexOf('_');
      return { kind: 'cyc', group: us >= 0 ? s.slice(0, us) : s, type: us >= 0 ? s.slice(us + 1) : '',
               day: day, hospital: hosp };
    }
    return null;
  }

  function hasContent(r) {
    return !!(r && (r.attendance || r.evaluated || (typeof r.total === 'number') ||
             (typeof r.manualTotal === 'number') || (r.scores && Object.keys(r.scores).length) ||
             (r.notes && String(r.notes).trim()) || r.paperDelivered === true || r.paperDelivered === false));
  }

  window.bridgeSession = function (key, sess) {
    if (!window.Store || !window.Store.isReady() || !sess || typeof sess !== 'object') return;
    var meta = parseKey(key); if (!meta) return;
    var names = Array.isArray(sess.__names__) ? sess.__names__ : [];
    Object.keys(sess).forEach(function (idx) {
      if (!/^\d+$/.test(idx)) return;
      var old = sess[idx]; if (!hasContent(old)) return;
      var nm = String((old && old.name) || names[parseInt(idx, 10)] || '').trim();
      if (!nm) return;
      var sid = resolveStudentId(nm);
      var evalId, patch = {
        studentId: sid,
        attendance: old.attendance || null,
        attendanceTime: old.attendanceTime || null,
        scores: old.scores || {},
        total: (typeof old.total === 'number') ? old.total :
               (typeof old.manualTotal === 'number' ? Math.min(15, old.manualTotal) : null),
        evaluated: !!old.evaluated,
        notes: old.notes || '',
        paperDelivered: (old.paperDelivered === true || old.paperDelivered === false) ? old.paperDelivered : null,
        locked: !!old.locked,
        entrustment: old.entrustment || null,
        feedback: old.feedback || { well: '', improve: '' },
        cases: Array.isArray(old.cases) ? old.cases : [],
        evaluatorUid: (window.currentUser ? currentUser.uid : null),
        evaluatorName: (window.currentUser ? (currentUser.displayName || currentUser.email || '') : ''),
        source: 'bridge'
      };
      if (typeof old.manualTotal === 'number') patch.manualTotal = old.manualTotal;
      if (old.signature) patch.signature = old.signature;
      if (old.amended) patch.amended = true;
      if (meta.kind === 'daily') {
        var hosp = sess.__hospital__ || (window.eva.config.settings && window.eva.config.settings.hospitalName) || '';
        patch.dateISO = meta.dateISO; patch.groupId = meta.shift; patch.hospitalId = hospitalId(hosp);
        if (sess.__dayNo__) patch.legacyCycleDay = parseInt(sess.__dayNo__, 10) || null;
        evalId = meta.dateISO + '_' + meta.shift + '_' + patch.hospitalId + '_' + sid;
      } else {
        var gid = groupIdFor(meta.group, meta.type);
        var hid = meta.hospital ? hospitalId(meta.hospital) : 'h_unknown';
        patch.dateISO = null; patch.groupId = gid; patch.hospitalId = hid; patch.legacyCycleDay = meta.day;
        evalId = 'cycd' + meta.day + '_' + gid + '_' + hid + '_' + sid;
      }
      // multi-evaluator (6.4): keep a per-rater sub-record. Two evaluators on
      // the same student/day land on the SAME evalId; each rater's numbers
      // live under byEvaluator[uid] and the displayed total is their average.
      var existing = window.eva.evaluations[evalId];
      if (patch.evaluated && patch.total != null && patch.evaluatorUid) {
        var byEv = (existing && existing.byEvaluator) ? JSON.parse(JSON.stringify(existing.byEvaluator)) : {};
        byEv[patch.evaluatorUid] = { total: patch.total, scores: patch.scores, ts: Date.now(),
                                     name: patch.evaluatorName || patch.evaluatorUid,
                                     entrustment: patch.entrustment || null };
        patch.byEvaluator = byEv;
      } else if (existing && existing.byEvaluator) {
        patch.byEvaluator = existing.byEvaluator;
      }
      // skip if unchanged (cheap content signature) to avoid audit/outbox churn
      var sig = JSON.stringify([patch.attendance, patch.total, patch.scores, patch.notes, patch.paperDelivered,
                                patch.locked, patch.entrustment, patch.feedback, patch.cases, patch.signature || null,
                                patch.byEvaluator || null]);
      if (existing && existing._sig === sig) return;
      patch._sig = sig;
      window.Store.update('evaluations.' + evalId, function (draft) {
        if (draft) { Object.keys(patch).forEach(function (k) { draft[k] = patch[k]; }); return draft; }
        return patch;
      }, { action: 'bridge:' + (meta.kind === 'daily' ? 'daily' : 'cycle') + ':' + evalId });
    });
  };
})();
