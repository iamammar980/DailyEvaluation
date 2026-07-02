/* ── Roles + student self-identification (6.3) ──────────────────────────
   Three roles: admin, evaluator (default), student.
   Source of truth is a server-side node `users/{uid}/eva/role` (or a
   /roles/{uid} node); mirrored locally. Offline/unknown → evaluator, EXCEPT
   when a local demo override is set (hsp_role_override) for testing without
   the backend. A student's uid maps to their studentId by matching their
   sign-in email against the registry (eva.students[].email).

   Authorization note: this is a CLIENT-SIDE convenience layer. Real
   enforcement (a student cannot read other students' data) must live in the
   Firebase security rules — see database.rules.json. The portal below only
   RENDERS the student's own records; it never fetches the full store from a
   student session in production (rules block it).                          */
(function () {
  'use strict';

  var _role = null, _studentId = null, _resolved = false;

  function localOverride() {
    try { return localStorage.getItem('hsp_role_override') || ''; } catch (e) { return ''; }
  }

  function resolveStudentId() {
    var email = (window.currentUser && currentUser.email) ? String(currentUser.email).trim().toLowerCase() : '';
    if (!email || !window.eva) return null;
    var ids = Object.keys(window.eva.students || {});
    for (var i = 0; i < ids.length; i++) {
      var s = window.eva.students[ids[i]];
      if (s && s.email && String(s.email).trim().toLowerCase() === email) return ids[i];
    }
    return null;
  }

  var Roles = {
    current: function () { return _role || 'evaluator'; },
    isAdmin: function () { return this.current() === 'admin'; },
    isStudent: function () { return this.current() === 'student'; },
    isEvaluator: function () { return this.current() === 'evaluator' || this.current() === 'admin'; },
    studentId: function () { return _studentId; },
    resolved: function () { return _resolved; },

    // set/read the role. In production an admin sets this per uid; here we
    // also honor a local override so the portal can be demoed offline.
    setLocalRole: function (role) {
      try { if (role) localStorage.setItem('hsp_role_override', role); else localStorage.removeItem('hsp_role_override'); } catch (e) {}
      _role = role || null; _resolved = false;
      this.resolve();
    },

    resolve: function (cb) {
      var ov = localOverride();
      function done(r) {
        _role = r || 'evaluator';
        _studentId = (_role === 'student') ? resolveStudentId() : null;
        _resolved = true;
        if (window.bus) bus.emit('role:resolved', { role: _role, studentId: _studentId });
        if (cb) cb(_role);
      }
      if (ov) { done(ov); return; }
      // Read the role from the TOP-LEVEL roles/{uid} node — NOT users/{uid}/role.
      // A user has write access to their own users/{uid} subtree, so a role
      // stored there could be self-promoted; the separate roles/{uid} node is
      // admin-write-only per database.rules.json, closing that hole.
      try {
        if (!window.isOfflineMode && window.currentUser && window.db) {
          window.db.ref('roles/' + currentUser.uid).once('value').then(function (snap) {
            done(snap.val() || 'evaluator');
          }).catch(function () { done('evaluator'); });
          return;
        }
      } catch (e) {}
      done('evaluator');
    }
  };

  window.Roles = Roles;
  if (window.bus) {
    bus.on('store:ready', function () { Roles.resolve(); });
    bus.on('students:changed', function () { if (_role === 'student' && !_studentId) { _studentId = resolveStudentId(); if (_studentId && window.bus) bus.emit('role:resolved', { role: _role, studentId: _studentId }); } });
  }
})();
