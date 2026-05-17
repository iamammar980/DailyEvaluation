// ═══════════════════════════════════════════════════════════
// SERVICE WORKER — Option A
// Caches everything on first visit so app works fully offline
// ═══════════════════════════════════════════════════════════

var CACHE_NAME = 'hospital-eval-v1';

// Everything that needs to work offline
var CACHE_URLS = [
  '/',
  '/index.html',
  '/offline.html',
  // Firebase SDKs
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-database-compat.js',
  // SheetJS
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  // Google Sign-In icon
  'https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg'
];

// ── INSTALL: cache everything on first visit ──
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      console.log('[SW] Caching all resources...');
      // Cache each URL individually so one failure doesn't block others
      return Promise.allSettled(
        CACHE_URLS.map(function(url) {
          return cache.add(url).catch(function(err) {
            console.warn('[SW] Failed to cache:', url, err);
          });
        })
      );
    }).then(function() {
      console.log('[SW] Install complete');
      return self.skipWaiting();
    })
  );
});

// ── ACTIVATE: clean up old caches ──
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; })
            .map(function(k) { return caches.delete(k); })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// ── FETCH: serve from cache, fall back to network ──
self.addEventListener('fetch', function(event) {
  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // Skip Firebase auth/database API calls (must be live)
  var url = event.request.url;
  if (url.includes('firebaseio.com') ||
      url.includes('identitytoolkit') ||
      url.includes('securetoken.google.com') ||
      url.includes('googleapis.com/identitytoolkit')) {
    return; // Let these go to network always
  }

  event.respondWith(
    caches.match(event.request).then(function(cached) {
      if (cached) {
        // Serve from cache immediately
        // Also update cache in background (stale-while-revalidate)
        var fetchPromise = fetch(event.request).then(function(response) {
          if (response && response.status === 200) {
            var clone = response.clone();
            caches.open(CACHE_NAME).then(function(cache) {
              cache.put(event.request, clone);
            });
          }
          return response;
        }).catch(function() { /* offline - ignore */ });

        return cached;
      }

      // Not in cache - try network
      return fetch(event.request).then(function(response) {
        if (!response || response.status !== 200 || response.type === 'opaque') {
          return response;
        }
        // Cache the new resource
        var clone = response.clone();
        caches.open(CACHE_NAME).then(function(cache) {
          cache.put(event.request, clone);
        });
        return response;
      }).catch(function() {
        // Network failed and not in cache
        // If it's a page request, show offline fallback
        if (event.request.mode === 'navigate') {
          return caches.match('/offline.html');
        }
        return new Response('', { status: 503 });
      });
    })
  );
});

// ── MESSAGE: force update ──
self.addEventListener('message', function(event) {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
