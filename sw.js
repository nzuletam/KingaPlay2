// KingaPlay Service Worker v3.1
// Cumple con los requisitos de PWABuilder:
// - fetch handler presente y funcional
// - estrategia Cache First para assets
// - Network First para navegación
// - No cachea blob URLs (audio/video del usuario)

const CACHE_NAME    = 'kingaplay-v3';
const OFFLINE_PAGE  = './index.html';

const PRECACHE_ASSETS = [
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
];

// ── INSTALL: precachear assets principales ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE: limpiar caches viejos ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(cacheNames => Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

// ── FETCH: estrategia híbrida ──
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Ignorar blob URLs (archivos multimedia del usuario)
  if (request.url.startsWith('blob:')) return;

  // Ignorar peticiones de extensiones de Chrome
  if (request.url.startsWith('chrome-extension:')) return;

  // Ignorar peticiones que no sean http/https
  if (!request.url.startsWith('http')) return;

  // Navegación → Network First con fallback a cache
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .catch(() => caches.match(OFFLINE_PAGE))
    );
    return;
  }

  // Assets propios (mismo origen) → Cache First
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request)
        .then(cached => {
          if (cached) return cached;
          return fetch(request)
            .then(response => {
              // Solo cachear respuestas válidas
              if (!response || response.status !== 200 || response.type === 'opaque') {
                return response;
              }
              const clone = response.clone();
              caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
              return response;
            });
        })
        .catch(() => caches.match(OFFLINE_PAGE))
    );
    return;
  }

  // Recursos externos (fuentes, etc.) → Network con fallback a cache
  event.respondWith(
    fetch(request).catch(() => caches.match(request))
  );
});

// ── MENSAJE: forzar actualización ──
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
