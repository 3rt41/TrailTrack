// Service worker: app utilizzabile offline + cache delle mappe già viste.
const SHELL = 'trailtrack-shell-v3';
const TILES = 'trailtrack-tiles-v1';
const MAX_TILES = 3000;
const ASSETS = [
  './', 'index.html', 'app.css', 'app.js', 'icon.svg', 'manifest.webmanifest',
  'vendor/leaflet/leaflet.css', 'vendor/leaflet/leaflet.js',
  'vendor/leaflet/images/layers.png', 'vendor/leaflet/images/layers-2x.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => ![SHELL, TILES].includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const isTile = (url) => /tile\.openstreetmap\.org|tile\.opentopomap\.org|arcgisonline\.com\/ArcGIS/.test(url);

async function trimTiles() {
  const c = await caches.open(TILES); const keys = await c.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = req.url;
  if (isTile(url)) {
    // mappe: prima la cache (utile in montagna senza campo), poi la rete
    e.respondWith(caches.open(TILES).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') { c.put(req, res.clone()); trimTiles(); }
        return res;
      } catch { return new Response('', { status: 504 }); }
    }));
    return;
  }
  if (url.includes('api.open-meteo.com')) return; // sempre rete
  // app: rete se disponibile (aggiornamenti), altrimenti cache
  e.respondWith(fetch(req).then((res) => {
    if (res.ok && (url.startsWith(self.location.origin))) {
      const copy = res.clone(); caches.open(SHELL).then((c) => c.put(req, copy));
    }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true })));
});
