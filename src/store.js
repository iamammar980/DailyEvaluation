/* ── Data core: the ONE canonical store (schema v2) ──────────────────────
   eva = {
     meta:        { schemaVersion, deviceId, lastMigration },
     students:    { [studentId]: {id, name, nameAr, email, group, area, active} },
     config:      { groups, hospitals, schedule, cycleLengthDays, settings },
     evaluations: { [evalId]: { dateISO, groupId, hospitalId, studentId,
                                attendance, scores, feedback, cases, entrustment,
                                evaluatorUid, evaluatorName, signature, locked,
                                notes, total, paperDelivered,
                                createdAt, updatedAt, rev } },
     flags:       { [studentId]: [ {ruleId, severity, msg, dateISO, seen} ] },
   }
   evalId = dateISO + '_' + groupId + '_' + hospitalId + '_' + studentId

   RULES (enforced by convention + the phase-3 grep guard):
   • No code outside src/store.js and src/sync.js may touch localStorage,
     indexedDB or firebase.database() directly.
   • Every mutation goes through Store.update() — which persists, appends
     the audit entry, enqueues sync, and emits the bus event in one place.
   Durable layer: IndexedDB ('eva-db'); the in-memory `eva` object is the
   synchronous working copy. */
(function () {
  'use strict';

  window.eva = {
    meta: { schemaVersion: 2, deviceId: null, lastMigration: null },
    students: {},
    config: { groups: [], hospitals: [], schedule: [], cycleLengthDays: 4, settings: {} },
    evaluations: {},
    flags: {}
  };

  /* ── tiny promise wrapper over IndexedDB ── */
  var DB_NAME = 'eva-db', DB_VER = 1, _db = null, idbOk = true;
  function idbOpen() {
    return new Promise(function (res, rej) {
      if (!window.indexedDB) { idbOk = false; return res(null); }
      var rq = indexedDB.open(DB_NAME, DB_VER);
      rq.onupgradeneeded = function (e) {
        var d = e.target.result;
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('evaluations')) d.createObjectStore('evaluations');
        if (!d.objectStoreNames.contains('audit')) d.createObjectStore('audit', { autoIncrement: true });
        if (!d.objectStoreNames.contains('outbox')) d.createObjectStore('outbox', { autoIncrement: true });
      };
      rq.onsuccess = function () { _db = rq.result; res(_db); };
      rq.onerror = function () { idbOk = false; res(null); };
    });
  }
  function tx(store, mode) { return _db.transaction(store, mode).objectStore(store); }
  function idbPut(store, key, val) {
    return new Promise(function (res) {
      if (!_db) return res(false);
      try {
        var rq = (key === undefined) ? tx(store, 'readwrite').add(val) : tx(store, 'readwrite').put(val, key);
        rq.onsuccess = function () { res(true); };
        rq.onerror = function () { res(false); };
      } catch (e) { res(false); }
    });
  }
  function idbDel(store, key) {
    return new Promise(function (res) {
      if (!_db) return res(false);
      try { var rq = tx(store, 'readwrite').delete(key); rq.onsuccess = function(){res(true);}; rq.onerror = function(){res(false);}; }
      catch (e) { res(false); }
    });
  }
  function idbGet(store, key) {
    return new Promise(function (res) {
      if (!_db) return res(undefined);
      try { var rq = tx(store, 'readonly').get(key); rq.onsuccess = function(){res(rq.result);}; rq.onerror = function(){res(undefined);}; }
      catch (e) { res(undefined); }
    });
  }
  function idbAll(store) {
    return new Promise(function (res) {
      if (!_db) return res({ keys: [], values: [] });
      try {
        var os = tx(store, 'readonly'), keys = [], values = [];
        var rq = os.openCursor();
        rq.onsuccess = function (e) {
          var c = e.target.result;
          if (c) { keys.push(c.key); values.push(c.value); c.continue(); }
          else res({ keys: keys, values: values });
        };
        rq.onerror = function () { res({ keys: keys, values: values }); };
      } catch (e) { res({ keys: [], values: [] }); }
    });
  }

  /* ── path helpers ── */
  function getPath(obj, path) {
    if (!path) return obj;
    var parts = String(path).split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i++) { if (cur == null) return undefined; cur = cur[parts[i]]; }
    return cur;
  }

  function nowIso() { return new Date().toISOString(); }
  function clone(v) { try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; } }

  var _ready = false, _readyCbs = [];

  window.Store = {
    /* read from the in-memory state */
    get: function (path) { return getPath(window.eva, path); },

    ready: function (cb) { if (_ready) cb(); else _readyCbs.push(cb); },
    isReady: function () { return _ready; },

    /* THE one mutation door.
       path:    'evaluations.<evalId>' | 'students' | 'students.<id>' |
                'config' | 'config.settings' | 'flags' | 'flags.<id>' | 'meta'
       patchFn: function(draft){ ...mutate or return replacement... }
       meta:    { action, uid, name, event, silent } */
    update: function (path, patchFn, meta) {
      meta = meta || {};
      var parts = String(path).split('.');
      var slice = parts[0];
      var before = clone(getPath(window.eva, path));

      /* apply */
      var draft = getPath(window.eva, path);
      var result;
      if (typeof patchFn === 'function') {
        if (draft === undefined || draft === null || typeof draft !== 'object') {
          result = patchFn(draft);
        } else {
          result = patchFn(draft);
          if (result === undefined) result = draft; // in-place mutation style
        }
      } else {
        result = patchFn; // direct value
      }
      /* write back into eva */
      if (parts.length === 1) {
        window.eva[slice] = result;
      } else {
        var parent = getPath(window.eva, parts.slice(0, -1).join('.'));
        if (parent == null) { // build intermediate objects
          parent = window.eva;
          for (var i = 0; i < parts.length - 1; i++) {
            if (parent[parts[i]] == null) parent[parts[i]] = {};
            parent = parent[parts[i]];
          }
        }
        if (result === undefined) { delete parent[parts[parts.length - 1]]; }
        else parent[parts[parts.length - 1]] = result;
      }

      /* evaluation bookkeeping: rev/updatedAt stamps */
      var evalId = null;
      if (slice === 'evaluations' && parts.length >= 2) {
        evalId = parts[1];
        var rec = window.eva.evaluations[evalId];
        if (rec) {
          rec.updatedAt = Date.now();
          rec.rev = (rec.rev || 0) + 1;
          if (!rec.createdAt) rec.createdAt = rec.updatedAt;
        }
      }

      /* persist (async, never blocks the UI) */
      if (slice === 'evaluations') {
        if (evalId) {
          var v = window.eva.evaluations[evalId];
          if (v === undefined) idbDel('evaluations', evalId); else idbPut('evaluations', evalId, clone(v));
        } else {
          // whole-slice replace (migration) — persist each record
          Object.keys(window.eva.evaluations).forEach(function (id) {
            idbPut('evaluations', id, clone(window.eva.evaluations[id]));
          });
        }
      } else {
        idbPut('kv', slice, clone(window.eva[slice]));
      }

      /* audit — every mutation, automatically (no manual calls anywhere) */
      if (!meta.noAudit) {
        var entry = {
          ts: Date.now(),
          uid: meta.uid || (window.currentUser ? currentUser.uid : 'local'),
          name: meta.name || (window.currentUser ? (currentUser.displayName || currentUser.email || '') : ''),
          action: meta.action || ('update:' + path),
          evalId: evalId,
          before: before,
          after: clone(getPath(window.eva, path))
        };
        idbPut('audit', undefined, entry);
        window.bus.emit('audit:appended', entry);
      }

      /* sync outbox — replayed by src/sync.js when online */
      if (!meta.noSync) {
        var item = { path: path, value: clone(getPath(window.eva, path)), ts: Date.now(),
                     rev: evalId && window.eva.evaluations[evalId] ? window.eva.evaluations[evalId].rev : null,
                     deviceId: window.eva.meta.deviceId };
        idbPut('outbox', undefined, item);
        window.bus.emit('outbox:queued', item);
      }

      /* notify */
      if (!meta.silent) {
        var ev = meta.event ||
          (slice === 'evaluations' ? 'evaluation:saved' :
           slice === 'students' ? 'students:changed' :
           slice === 'config' ? 'config:changed' :
           slice === 'flags' ? 'flags:changed' : 'state:changed');
        window.bus.emit(ev, { path: path, evalId: evalId });
      }
      return getPath(window.eva, path);
    },

    subscribe: function (ev, fn) { return window.bus.on(ev, fn); },

    /* explicit deletion (update()'s patchFn cannot express it: a mutating
       patch returns undefined and means "keep the draft") */
    remove: function (path, meta) {
      meta = meta || {};
      var parts = String(path).split('.');
      if (parts.length < 2) return false; // whole slices are never removed
      var before = clone(getPath(window.eva, path));
      if (before === undefined) return false;
      var parent = getPath(window.eva, parts.slice(0, -1).join('.'));
      if (parent == null) return false;
      delete parent[parts[parts.length - 1]];

      var slice = parts[0];
      var evalId = (slice === 'evaluations') ? parts[1] : null;
      if (slice === 'evaluations' && parts.length === 2) idbDel('evaluations', evalId);
      else idbPut('kv', slice, clone(window.eva[slice]));

      if (!meta.noAudit) {
        var entry = {
          ts: Date.now(),
          uid: meta.uid || (window.currentUser ? currentUser.uid : 'local'),
          name: meta.name || (window.currentUser ? (currentUser.displayName || currentUser.email || '') : ''),
          action: meta.action || ('remove:' + path),
          evalId: evalId, before: before, after: null
        };
        idbPut('audit', undefined, entry);
        window.bus.emit('audit:appended', entry);
      }
      if (!meta.noSync) {
        var item = { path: path, value: null, removed: true, ts: Date.now(),
                     rev: null, deviceId: window.eva.meta.deviceId };
        idbPut('outbox', undefined, item);
        window.bus.emit('outbox:queued', item);
      }
      if (!meta.silent) {
        var ev = meta.event ||
          (slice === 'evaluations' ? 'evaluation:saved' :
           slice === 'students' ? 'students:changed' :
           slice === 'config' ? 'config:changed' :
           slice === 'flags' ? 'flags:changed' : 'state:changed');
        window.bus.emit(ev, { path: path, evalId: evalId, removed: true });
      }
      return true;
    },

    /* audit + outbox accessors (store-internal persistence, read-only API) */
    auditRecent: function (limit) {
      return idbAll('audit').then(function (r) {
        var v = r.values || [];
        return v.slice(Math.max(0, v.length - (limit || 200)));
      });
    },
    outboxDrain: function (handler) {
      /* handler(item) → Promise(success). Items removed only on success. */
      return idbAll('outbox').then(function (r) {
        var chain = Promise.resolve(true);
        r.keys.forEach(function (k, i) {
          chain = chain.then(function () {
            return handler(r.values[i]).then(function (ok) {
              if (ok) return idbDel('outbox', k);
              return false;
            });
          });
        });
        return chain;
      });
    },
    outboxCount: function () { return idbAll('outbox').then(function (r) { return r.keys.length; }); },

    /* boot: open IDB, hydrate memory */
    init: function () {
      return idbOpen().then(function () {
        return Promise.all([
          idbGet('kv', 'meta'), idbGet('kv', 'students'), idbGet('kv', 'config'),
          idbGet('kv', 'flags'), idbAll('evaluations')
        ]);
      }).then(function (r) {
        if (r[0]) window.eva.meta = r[0];
        if (r[1]) window.eva.students = r[1];
        if (r[2]) window.eva.config = r[2];
        if (r[3]) window.eva.flags = r[3];
        var ev = r[4];
        ev.keys.forEach(function (k, i) { window.eva.evaluations[k] = ev.values[i]; });
        if (!window.eva.meta.deviceId) {
          window.eva.meta.deviceId = 'dev_' + Math.random().toString(36).slice(2, 10);
          idbPut('kv', 'meta', clone(window.eva.meta));
        }
        _ready = true;
        _readyCbs.splice(0).forEach(function (cb) { try { cb(); } catch (e) {} });
        window.bus.emit('store:ready', {});
      });
    }
  };

  /* self-boot: consumers gate on Store.ready(cb) */
  window.Store.init();
})();
