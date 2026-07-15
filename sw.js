/* Calamity Space — full asset cache (Pages + local) */
const CACHE = 'solar-nemesis-v49';
const CDN_CACHE = 'solar-cdn-v4';

const PRECACHE = [
  './',
  './index.html',
  './css/style.css',
  './js/game.js',
  './manifest.webmanifest',
  './icon/calamity-logo.png',
  './icon/icon-192.png',
  './icon/icon-512.png',
  './icon/apple-touch-icon.png',
  './icon/favicon-32.png',
  './icon/favicon-16.png',
  './sounds/engine-ambient.mp3',
  './sounds/warp.flac',
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
];

const CDN_PREFETCH = [
  'https://unpkg.com/three@0.170.0/build/three.module.js',
  'https://unpkg.com/three@0.170.0/examples/jsm/controls/PointerLockControls.js',
  'https://unpkg.com/three@0.170.0/examples/jsm/postprocessing/EffectComposer.js',
  'https://unpkg.com/three@0.170.0/examples/jsm/postprocessing/RenderPass.js',
  'https://unpkg.com/three@0.170.0/examples/jsm/postprocessing/ShaderPass.js',
  'https://unpkg.com/three@0.170.0/examples/jsm/postprocessing/OutputPass.js',
  'https://unpkg.com/three@0.170.0/examples/jsm/postprocessing/UnrealBloomPass.js',
  'https://unpkg.com/three@0.170.0/examples/jsm/postprocessing/Pass.js',
  'https://unpkg.com/three@0.170.0/examples/jsm/shaders/FXAAShader.js',
  'https://unpkg.com/three@0.170.0/examples/jsm/shaders/CopyShader.js',
  'https://unpkg.com/three@0.170.0/examples/jsm/shaders/LuminosityHighPassShader.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const local = await caches.open(CACHE);
    await local.addAll(PRECACHE).catch(() => undefined);

    const cdn = await caches.open(CDN_CACHE);
    await Promise.all(CDN_PREFETCH.map(async (url) => {
      try {
        const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
        if (res.ok) await cdn.put(url, res.clone());
      } catch (_) { /* offline / CORS */ }
    }));

    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  const keep = new Set([CACHE, CDN_CACHE]);
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isThreeCdn(url) {
  return url.hostname === 'unpkg.com' && url.pathname.includes('/three@0.170.0/');
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) {
    // Soft refresh in background
    fetch(req).then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
    }).catch(() => {});
    return hit;
  }
  const res = await fetch(req);
  if (res && res.ok) cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Three.js CDN — cache forever for this pin
  if (isThreeCdn(url)) {
    event.respondWith(cacheFirst(req, CDN_CACHE).catch(() => fetch(req)));
    return;
  }

  // Only same-origin for the rest
  if (url.origin !== self.location.origin) return;

  // HTML: network first, then cache
  if (req.mode === 'navigate' || url.pathname.endsWith('.html') || /\/$/.test(url.pathname)) {
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

  // App assets: cache first
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
