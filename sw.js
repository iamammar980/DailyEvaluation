/* ──────────────────────────────────────────────────────────────────────
   Service Worker — تقييم الممارسة اليومية
   Strategy:
     • App shell (index.html, offline.html, icons, manifest) is precached so
       the app opens with no network.
     • Navigation requests: network-first, falling back to cached index.html
       (so a refresh offline still loads the app, not a browser error).
     • Same-origin static assets: stale-while-revalidate.
     • Cross-origin (Firebase, ImgBB proxy, CDNs): never intercepted — let the
       app's own offline queue + live sync handle those.
   Bump CACHE_VERSION whenever you change cached files to force an update.
   ────────────────────────────────────────────────────────────────────── */
const CACHE_VERSION = 'hsp-v3';
const PRECACHE = [
  '/index.html',
  '/offline.html',
  '/manifest.json',
  '/src/bus.js',
  '/src/store.js',
  '/src/migrate.js',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png'
];

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(function(cache) { return cache.addAll(PRECACHE); })
      .then(function() { return self.skipWaiting(); })
      .catch(function() { /* precache failure shouldn't block install */ })
  );
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_VERSION; })
            .map(function(k) { return caches.delete(k); })
      );
    }).then(function() { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(event) {
  const req = event.request;

  // Only handle GET; let everything else (POST to Firebase/proxy) pass through.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never touch cross-origin requests — Firebase, the upload proxy, Google
  // auth, and CDNs must always go straight to the network.
  if (url.origin !== self.location.origin) return;

  // Navigations: network-first with cached index.html fallback.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(function() {
        return caches.match('/index.html').then(function(cached) {
          return cached || caches.match('/offline.html');
        });
      })
    );
    return;
  }

  // Same-origin static assets: stale-while-revalidate.
  event.respondWith(
    caches.match(req).then(function(cached) {
      const network = fetch(req).then(function(res) {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then(function(cache) { cache.put(req, copy); });
        }
        return res;
      }).catch(function() { return cached; });
      return cached || network;
    })
  );
});

// Allow the page to trigger an immediate update via postMessage.
self.addEventListener('message', function(event) {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
