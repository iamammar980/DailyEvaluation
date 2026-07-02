/* ── Flag engine: derived "needs follow-up" signals ─────────────────────
   Runs a rule pass on every evaluation:saved / attendance:changed, over the
   canonical Store, and writes eva.flags[studentId] = [ {ruleId, severity,
   msg, dateISO, seen} ]. Views render these (badge in Attendance, banner in
   Progress, line on the Daily Paper). Thresholds live in config.settings.  */
(function () {
  'use strict';

  function cfg() {
    var s = (window.eva && window.eva.config && window.eva.config.settings) || {};
    return {
      lowScore: (typeof s.flagLowScore === 'number') ? s.flagLowScore : 9,      // /15
      lowCount: (typeof s.flagLowCount === 'number') ? s.flagLowCount : 2,      // occurrences
      absences: (typeof s.flagAbsences === 'number') ? s.flagAbsences : 2,      // per window
      trendMin: (typeof s.flagTrendPts === 'number') ? s.flagTrendPts : 3       // points for slope
    };
  }

  function total(r) {
    return window.Selectors ? Selectors.recordTotal(r) : (typeof r.total === 'number' ? r.total : null);
  }

  // simple least-squares slope over the last N graded totals
  function slope(vals) {
    var n = vals.length; if (n < 2) return 0;
    var sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (var i = 0; i < n; i++) { sx += i; sy += vals[i]; sxy += i * vals[i]; sxx += i * i; }
    var d = (n * sxx - sx * sx); if (!d) return 0;
    return (n * sxy - sx * sy) / d;
  }

  function evalRules(studentId) {
    var c = cfg();
    var tl = window.Selectors ? Selectors.getStudentTimeline(studentId) : [];
    var flags = [];
    var graded = tl.filter(function (t) { return t.total != null; });
    var lastDate = graded.length ? (graded[graded.length - 1].dateISO || '') : '';

    // 1) low score, ≥ lowCount times
    var lows = graded.filter(function (t) { return t.total < c.lowScore; });
    if (lows.length >= c.lowCount) {
      flags.push({ ruleId: 'lowScore', severity: 'warn',
        msg: '⚠️ متابعة أكاديمية — ' + lows.length + ' تقييم دون ' + c.lowScore + '/15', dateISO: lastDate, seen: false });
    }
    // 2) absences
    var abs = tl.filter(function (t) { return t.attendance === 'absent'; });
    if (abs.length >= c.absences) {
      flags.push({ ruleId: 'attendance', severity: 'danger',
        msg: '🚩 حضور — ' + abs.length + ' غياب', dateISO: lastDate, seen: false });
    }
    // 3) declining trend over the last trendMin+ graded totals
    if (graded.length >= c.trendMin) {
      var recent = graded.slice(-Math.max(c.trendMin, 4)).map(function (t) { return t.total; });
      if (slope(recent) <= -0.75) {
        flags.push({ ruleId: 'trend', severity: 'warn',
          msg: '📉 تراجع — الدرجات في انخفاض', dateISO: lastDate, seen: false });
      }
    }
    return flags;
  }

  var _running = false;
  function runPass(scopeStudentId) {
    if (_running || !window.Store || !window.Store.isReady()) return;
    _running = true;
    try {
      var ids = scopeStudentId ? [scopeStudentId] : Object.keys(window.eva.students);
      var next = JSON.parse(JSON.stringify(window.eva.flags || {}));
      var changed = false;
      ids.forEach(function (sid) {
        var fresh = evalRules(sid);
        // preserve `seen` acknowledgements across recomputes (by ruleId)
        var prev = (window.eva.flags && window.eva.flags[sid]) || [];
        fresh.forEach(function (f) {
          var was = prev.filter(function (p) { return p.ruleId === f.ruleId; })[0];
          if (was && was.seen) f.seen = true;
        });
        var before = JSON.stringify((next[sid] || []).map(function (f) { return f.ruleId + f.msg; }));
        var after = JSON.stringify(fresh.map(function (f) { return f.ruleId + f.msg; }));
        if (before !== after) changed = true;
        if (fresh.length) next[sid] = fresh; else delete next[sid];
      });
      if (changed) {
        window.Store.update('flags', function () { return next; },
          { action: 'flags:recompute', noSync: true, noAudit: true, event: 'flags:changed' });
      }
    } catch (e) { if (window.reportIssue) reportIssue('flags:runPass', e); }
    _running = false;
  }

  window.Flags = {
    run: runPass,
    forStudent: function (id) { return (window.eva.flags && window.eva.flags[id]) || []; },
    markSeen: function (id) {
      var f = window.eva.flags && window.eva.flags[id]; if (!f) return;
      f.forEach(function (x) { x.seen = true; });
      window.Store.update('flags.' + id, function () { return f; },
        { action: 'flags:seen', noSync: true, noAudit: true, event: 'flags:changed' });
    },
    // convenience for the daily grid: a compact badge string or ''
    badge: function (id) {
      var f = (window.eva.flags && window.eva.flags[id]) || [];
      if (!f.length) return '';
      var sev = f.some(function (x) { return x.severity === 'danger'; }) ? 'danger' : 'warn';
      return sev === 'danger' ? '🚩' : '⚠️';
    },
    // classic UI works by name — resolve then badge / list
    _idByName: function (name) {
      var nm = String(name || '').trim(); if (!nm) return null;
      var ids = Object.keys(window.eva.students || {});
      for (var i = 0; i < ids.length; i++) if (window.eva.students[ids[i]].name === nm) return ids[i];
      return null;
    },
    badgeByName: function (name) { var id = this._idByName(name); return id ? this.badge(id) : ''; },
    forName: function (name) { var id = this._idByName(name); return id ? this.forStudent(id) : []; }
  };

  function wire() {
    if (!window.bus) return;
    var t = null;
    function debounced(d) {
      clearTimeout(t);
      t = setTimeout(function () { runPass(d && d.evalId ? null : null); }, 150);
    }
    bus.on('evaluation:saved', debounced);
    bus.on('attendance:changed', debounced);
    bus.on('store:ready', function () { runPass(); });
    if (window.Store && Store.isReady()) runPass();
  }
  if (window.bus) wire(); else document.addEventListener('DOMContentLoaded', wire);
})();
