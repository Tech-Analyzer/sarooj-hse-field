// ============================================================
// Sarooj HSE Field PWA — service worker
// Caches the app shell so the app loads with zero signal.
// API calls (Apps Script) are never cached — they need the network
// (and the app queues them in IndexedDB when offline, see app.js).
// Bump CACHE when you change shell files to force an update.
// ============================================================
var CACHE = 'sarooj-hse-field-v4';
var SHELL = [
  './',
  './index.html',
  './styles.css',
  './config.js',
  './app.js',
  './manifest.json',
  './icons/icon.svg'
];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(c) { return c.addAll(SHELL); })
      .then(function() { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k) { return k !== CACHE; }).map(function(k) { return caches.delete(k); }));
    }).then(function() { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(e) {
  var url = e.request.url;
  // Let API calls hit the network directly (do not cache Apps Script).
  if (url.indexOf('script.google.com') > -1 || url.indexOf('googleusercontent.com') > -1) return;
  if (e.request.method !== 'GET') return;

  // App shell: cache-first, then network, then index fallback (offline nav).
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      return cached || fetch(e.request).then(function(resp) {
        return caches.open(CACHE).then(function(c) { try { c.put(e.request, resp.clone()); } catch (_) {} return resp; });
      }).catch(function() { return caches.match('./index.html'); });
    })
  );
});
