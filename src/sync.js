/* ── Sync: the ONLY Firebase writer for the v2 store ─────────────────────
   Every Store.update()/remove() enqueues an outbox item. This worker
   flushes them when online. The v2 canonical store syncs under a SEPARATE
   Firebase path (users/{uid}/eva/*) so it never collides with the legacy
   users/{uid}/{history,roster,...} nodes the classic code still writes.

   Conflict rule: per-record last-write-wins by updatedAt. If both sides
   changed an evaluation's scores within 10 minutes, keep BOTH under the
   record's conflicts[] and surface a review — a grade is never silently
   dropped. Deletions replay as tombstones.                                */
(function () {
  'use strict';

  var CONFLICT_WINDOW = 10 * 60 * 1000;
  var flushing = false, timer = null;

  function online() {
    return !window.isOfflineMode && window.currentUser && window.db;
  }
  function evaRef(sub) {
    // reuse the app's per-uid ref helper if present; else build it
    if (typeof window.dbRef === 'function') return dbRef('eva/' + sub);
    return db.ref('users/' + currentUser.uid + '/eva/' + sub);
  }

  // path 'evaluations.<id>' → firebase 'evaluations/<id>' (ids are already
  // sanitized of . # $ [ ] / at creation, but re-guard defensively)
  function fbPath(storePath) {
    return String(storePath).split('.').map(function (seg) {
      return seg.replace(/[.#$\[\]]/g, '-');
    }).join('/');
  }

  function setSync(state) {
    if (typeof window.setSyncStatus === 'function') { try { setSyncStatus(state); } catch (e) {} }
    window.bus.emit('sync:state', { state: state });
  }

  function writeItem(item) {
    return new Promise(function (res) {
      try {
        var ref = evaRef(fbPath(item.path));
        if (item.removed) {
          ref.remove().then(function () { res(true); }).catch(function () { res(false); });
          return;
        }
        // evaluation conflict check: compare remote updatedAt
        var isEval = item.path.indexOf('evaluations.') === 0;
        if (isEval) {
          ref.once('value').then(function (snap) {
            var remote = snap.val();
            var localRec = item.value;
            if (remote && remote.updatedAt && localRec && localRec.updatedAt &&
                remote.rev !== localRec.rev &&
                Math.abs(remote.updatedAt - localRec.updatedAt) < CONFLICT_WINDOW &&
                JSON.stringify(remote.scores || {}) !== JSON.stringify(localRec.scores || {})) {
              // genuine concurrent divergence — keep both, never drop
              var merged = (remote.updatedAt >= localRec.updatedAt) ? remote : localRec;
              merged = JSON.parse(JSON.stringify(merged));
              merged.conflicts = (merged.conflicts || []).concat([{
                at: Date.now(), rev: (remote.updatedAt >= localRec.updatedAt ? localRec.rev : remote.rev),
                scores: (remote.updatedAt >= localRec.updatedAt ? localRec.scores : remote.scores),
                total: (remote.updatedAt >= localRec.updatedAt ? localRec.total : remote.total),
                by: (remote.updatedAt >= localRec.updatedAt ? localRec.evaluatorName : remote.evaluatorName)
              }]);
              ref.set(merged).then(function () {
                window.bus.emit('sync:conflict', { path: item.path });
                if (typeof window.toast === 'function') toast('⚠️ تعارض في تقييم — حُفِظت النسختان للمراجعة');
                res(true);
              }).catch(function () { res(false); });
            } else if (!remote || !remote.updatedAt || (localRec.updatedAt || 0) >= (remote.updatedAt || 0)) {
              ref.set(localRec).then(function () { res(true); }).catch(function () { res(false); });
            } else {
              // remote is newer and non-conflicting — adopt it locally, drop our stale write
              window.eva.evaluations[item.path.split('.')[1]] = remote;
              res(true);
            }
          }).catch(function () { res(false); });
        } else {
          ref.set(item.value).then(function () { res(true); }).catch(function () { res(false); });
        }
      } catch (e) { res(false); }
    });
  }

  var Sync = {
    flush: function () {
      if (flushing || !online() || !window.Store) return Promise.resolve();
      flushing = true;
      setSync('saving');
      return Store.outboxDrain(writeItem).then(function () {
        flushing = false;
        return Store.outboxCount();
      }).then(function (n) {
        setSync(n > 0 ? 'pending' : 'saved');
      }).catch(function () { flushing = false; setSync('offline'); });
    },

    /* pull remote eva/* into local on (re)connect, then flush local queue */
    verify: function () {
      if (!online()) return Promise.resolve();
      return evaRef('evaluations').once('value').then(function (snap) {
        var remote = snap.val() || {};
        var changed = false;
        Object.keys(remote).forEach(function (id) {
          var r = remote[id], l = window.eva.evaluations[id];
          if (!l || (r.updatedAt || 0) > (l.updatedAt || 0)) { window.eva.evaluations[id] = r; changed = true; }
        });
        if (changed) window.bus.emit('evaluation:saved', { synced: true });
        return Sync.flush();
      }).catch(function () {});
    },

    start: function () {
      // flush on reconnect + a slow heartbeat; the outbox persists across reloads
      window.addEventListener('online', function () { Sync.verify(); });
      if (timer) clearInterval(timer);
      timer = setInterval(function () { if (online()) Sync.flush(); }, 30000);
      // flush whenever anything is queued
      window.bus.on('outbox:queued', function () { if (online()) Sync.flush(); });
      window.bus.on('store:ready', function () { if (online()) Sync.verify(); });
      if (online()) Sync.verify();
    }
  };

  window.Sync = Sync;
  // begin once the store is ready
  if (window.Store && Store.isReady && Store.isReady()) Sync.start();
  else if (window.bus) window.bus.on('store:ready', function () { Sync.start(); });
})();
