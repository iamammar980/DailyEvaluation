/* ── Selectors: the ONLY read path for views, exports and email ──────────
   Every derived read goes through here so the daily grid, statistics,
   progress, rotation, exports and any future student portal agree by
   construction. Pure functions over window.eva — no DOM, no side effects.
   Scoring is centralized: computeTotal() is the single 15-point rule.     */
(function () {
  'use strict';

  // FIELDS is defined in the main script; mirror the axis maxima defensively
  function fieldDefs() {
    if (window.FIELDS && Array.isArray(window.FIELDS)) return window.FIELDS;
    return [];
  }

  /* THE one scoring rule (max 15), used everywhere. */
  function computeTotal(scores) {
    if (!scores) return null;
    var defs = fieldDefs(), t = 0, any = false;
    if (defs.length) {
      defs.forEach(function (sec) {
        sec.items.forEach(function (it) {
          var v = parseFloat(scores[it.k]);
          if (!isNaN(v)) { t += Math.max(0, Math.min(v, it.m)); any = true; }
        });
      });
    } else {
      Object.keys(scores).forEach(function (k) {
        var v = parseFloat(scores[k]); if (!isNaN(v)) { t += v; any = true; }
      });
    }
    return any ? Math.round(Math.min(t, 15) * 100) / 100 : null;
  }

  /* effective day total for a record: multi-rater average when two or more
     evaluators graded it (6.4), else manual override, saved total, or sum */
  function recordTotal(r) {
    if (!r) return null;
    if (r.byEvaluator) {
      var ks = Object.keys(r.byEvaluator);
      if (ks.length >= 2) {
        var s = 0, n = 0;
        ks.forEach(function (k) { var t = r.byEvaluator[k] && r.byEvaluator[k].total;
          if (typeof t === 'number') { s += t; n++; } });
        if (n >= 2) return Math.round((s / n) * 100) / 100;
      }
    }
    if (typeof r.manualTotal === 'number') return Math.min(15, r.manualTotal);
    if (typeof r.total === 'number') return Math.min(15, r.total);
    return computeTotal(r.scores);
  }

  function evalsArray() {
    var e = window.eva.evaluations, out = [];
    Object.keys(e).forEach(function (id) { var r = e[id]; r._id = id; out.push(r); });
    return out;
  }

  var Selectors = {
    computeTotal: computeTotal,
    recordTotal: recordTotal,

    /* one student's full record (display) */
    student: function (id) { return window.eva.students[id] || null; },
    studentName: function (id) { var s = window.eva.students[id]; return s ? s.name : id; },
    allStudents: function () {
      return Object.keys(window.eva.students).map(function (id) { return window.eva.students[id]; });
    },

    /* a group's students, from config (id-based) */
    groupStudents: function (groupId) {
      var g = (window.eva.config.groups || []).filter(function (x) { return x.id === groupId; })[0];
      if (!g) return [];
      // config groups may store studentIds (new) or names (migrated) — normalize
      return (g.studentIds || g.students || []).map(function (ref) {
        return window.eva.students[ref] || Selectors.byName(ref);
      }).filter(Boolean);
    },
    byName: function (name) {
      var nm = String(name || '').trim();
      var ids = Object.keys(window.eva.students);
      for (var i = 0; i < ids.length; i++) if (window.eva.students[ids[i]].name === nm) return window.eva.students[ids[i]];
      return null;
    },

    /* all evaluations for one calendar day + shift(group) */
    getDay: function (dateISO, groupId) {
      return evalsArray().filter(function (r) {
        return r.dateISO === dateISO && (!groupId || r.groupId === groupId);
      });
    },

    /* one student's timeline (progress detail, portal) — chronological */
    getStudentTimeline: function (studentId) {
      var rows = evalsArray().filter(function (r) { return r.studentId === studentId; });
      rows.sort(function (a, b) {
        var ad = a.dateISO || ('~cyc' + (a.legacyCycleDay || 0));
        var bd = b.dateISO || ('~cyc' + (b.legacyCycleDay || 0));
        return ad < bd ? -1 : ad > bd ? 1 : 0;
      });
      return rows.map(function (r) {
        return { id: r._id, dateISO: r.dateISO, groupId: r.groupId, hospitalId: r.hospitalId,
                 total: recordTotal(r), attendance: r.attendance, paperDelivered: r.paperDelivered,
                 entrustment: r.entrustment, feedback: r.feedback, cases: r.cases || [],
                 legacyCycleDay: r.legacyCycleDay || null, scores: r.scores };
      });
    },

    /* rotation-day cards for one hospital block (rotation tab) */
    getCycle: function (hospitalId, groupId) {
      return evalsArray().filter(function (r) {
        return (!hospitalId || r.hospitalId === hospitalId) && (!groupId || r.groupId === groupId);
      });
    },

    /* group averages over a date range (statistics) */
    getGroupAverages: function (groupId, fromISO, toISO) {
      var rows = evalsArray().filter(function (r) {
        if (groupId && r.groupId !== groupId) return false;
        if (fromISO && r.dateISO && r.dateISO < fromISO) return false;
        if (toISO && r.dateISO && r.dateISO > toISO) return false;
        return true;
      });
      var byStudent = {};
      rows.forEach(function (r) {
        var t = recordTotal(r); if (t == null) return;
        (byStudent[r.studentId] = byStudent[r.studentId] || []).push(t);
      });
      var out = { students: {}, mean: null, count: 0 };
      var all = [];
      Object.keys(byStudent).forEach(function (sid) {
        var vals = byStudent[sid];
        var m = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
        out.students[sid] = { name: Selectors.studentName(sid), mean: +m.toFixed(2), days: vals.length, sum: +vals.reduce(function(a,b){return a+b;},0).toFixed(2) };
        vals.forEach(function (v) { all.push(v); });
      });
      out.count = all.length;
      out.mean = all.length ? +(all.reduce(function (a, b) { return a + b; }, 0) / all.length).toFixed(2) : null;
      return out;
    },

    /* per-evaluator leniency (statistics 6.7) */
    getEvaluatorStats: function () {
      var byEv = {}, cohort = [];
      evalsArray().forEach(function (r) {
        var t = recordTotal(r); if (t == null) return;
        cohort.push(t);
        var k = r.evaluatorUid || r.evaluatorName || 'legacy';
        (byEv[k] = byEv[k] || { key: k, name: r.evaluatorName || 'قديم', totals: [] }).totals.push(t);
      });
      var cMean = cohort.length ? cohort.reduce(function (a, b) { return a + b; }, 0) / cohort.length : 0;
      return Object.keys(byEv).map(function (k) {
        var e = byEv[k], m = e.totals.reduce(function (a, b) { return a + b; }, 0) / e.totals.length;
        return { key: k, name: e.name, mean: +m.toFixed(2), count: e.totals.length, delta: +(m - cMean).toFixed(2) };
      });
    },

    /* pending evaluations today for one evaluator (dashboard 6.5) */
    getPending: function (dateISO, evaluatorUid) {
      // pending = a scheduled group's student with no evaluated record today
      var done = {};
      Selectors.getDay(dateISO).forEach(function (r) {
        if (r.evaluated) done[r.studentId] = true;
      });
      var pending = [];
      (window.eva.config.groups || []).forEach(function (g) {
        Selectors.groupStudents(g.id).forEach(function (s) {
          if (s && !done[s.id]) pending.push({ studentId: s.id, name: s.name, groupId: g.id });
        });
      });
      return pending;
    }
  };

  window.Selectors = Selectors;
})();
