/* ── Event bus — the only way features talk to each other ────────────────
   Events in use:
     evaluation:saved   { evalId }        attendance:changed { evalId }
     students:changed   {}                config:changed     {}
     flags:changed      {}                sync:state         { state }
   Tabs render from current state on entry AND subscribe for live updates;
   no tab may call into another tab's code. */
(function () {
  'use strict';
  var handlers = {};
  window.bus = {
    on: function (ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return fn; },
    off: function (ev, fn) {
      var h = handlers[ev]; if (!h) return;
      var i = h.indexOf(fn); if (i >= 0) h.splice(i, 1);
    },
    emit: function (ev, data) {
      (handlers[ev] || []).slice().forEach(function (fn) {
        try { fn(data); } catch (e) { if (window.reportIssue) reportIssue('bus:' + ev, e); }
      });
    }
  };
})();
