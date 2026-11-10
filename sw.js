// =====================================================================
// sw.js — service worker. Сохраняет файлы приложения в кэш телефона,
// чтобы оно открывалось без интернета.
//
// Стратегия: сразу показываем версию из кэша (быстро и офлайн),
// а в фоне скачиваем свежую. Обновление появится при следующем запуске.
// Когда меняете список файлов — увеличьте номер версии.
// =====================================================================

const CACHE = 'budget-v2';
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
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(event.request, { ignoreSearch: true });
      const network = fetch(event.request)
        .then((res) => {
          if (res.ok) cache.put(event.request, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
