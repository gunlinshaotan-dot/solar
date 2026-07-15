/* Solar Nemesis — offline / fast-load cache for GitHub Pages */
const CACHE = 'solar-nemesis-v3';
const PRECACHE = [
  './',
  './index.html',
  './css/style.css',
  './js/game.js',
  './manifest.webmanifest',
  './textures/sun.jpg',
  './textures/mercury.jpg',
  './textures/venus.jpg',
  './textures/earth.jpg',
  './textures/earth_clouds.jpg',
  './textures/mars.jpg',
  './textures/jupiter.jpg',
  './textures/saturn.jpg',
  './textures/saturn_ring.png',
  './textures/uranus.jpg',
  './textures/neptune.jpg',
  './textures/moon.jpg',
  './textures/milkyway.jpg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(PRECACHE).catch(() => undefined))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Only same-origin (Pages / solar)
  if (url.origin !== self.location.origin) return;

  // HTML: network first, then cache (so updates land quickly)
  if (req.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
    );
    return;
  }

  // JS/CSS/textures/manifest: cache first, refresh in background
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
