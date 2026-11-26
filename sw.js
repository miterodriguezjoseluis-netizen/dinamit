// DINAMIT Service Worker v8.0
// Estrategia: Network First con fallback a cache para iOS Safari PWA

const CACHE_NAME = 'dinamit-v8';
const OFFLINE_URL = '/';

// Recursos a pre-cachear para funcionamiento offline básico
const PRECACHE_URLS = [
  '/',
  '/manifest.json'
];

// ── INSTALL ──────────────────────────────────────────────────────
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(PRECACHE_URLS);
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

// ── ACTIVATE ─────────────────────────────────────────────────────
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames
          .filter(function(name) { return name !== CACHE_NAME; })
          .map(function(name) { return caches.delete(name); })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// ── FETCH: Network First, Cache Fallback ─────────────────────────
self.addEventListener('fetch', function(event) {
  // Solo interceptar GET requests
  if (event.request.method !== 'GET') return;

  // No interceptar requests a APIs externas (Supercias, etc.)
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then(function(response) {
        // Guardar copia en cache si la respuesta es válida
        if (response && response.status === 200 && response.type === 'basic') {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(function() {
        // Sin red: intentar desde cache
        return caches.match(event.request).then(function(cached) {
          if (cached) return cached;
          // Fallback final: página principal desde cache
          return caches.match(OFFLINE_URL);
        });
      })
  );
});
