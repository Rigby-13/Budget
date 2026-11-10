// =====================================================================
// sw.js — service worker. Сохраняет файлы приложения на телефоне,
// чтобы оно открывалось без интернета.
//
// Стратегия «сначала сеть»: если интернет есть — всегда берём свежие
// файлы (и обновляем копию). Если сети нет или она очень медленная —
// показываем сохранённую копию. Так обновления приходят сразу,
// а старые и новые файлы никогда не смешиваются.
// =====================================================================

const VERSION = 4;
const CACHE = 'budget-v' + VERSION;
const NETWORK_TIMEOUT = 3000; // мс: дольше ждать сеть нет смысла
const FILES = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/db.js',
  './js/utils.js',
  './js/ui.js',
  './js/debts.js',
  './js/backup.js',
  './js/categories.js',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  // cache: 'reload' — мимо кэша браузера, чтобы точно взять свежие файлы
  event.waitUntil(
    caches.open(CACHE).then((c) =>
      c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await withTimeout(fetch(req, { cache: 'no-cache' }), NETWORK_TIMEOUT);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const cached = await cache.match(req, { ignoreSearch: true })
      || (req.mode === 'navigate' && await cache.match('./index.html'));
    return cached || Response.error();
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
