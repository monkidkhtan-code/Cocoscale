const CACHE_NAME = 'kh-cocoscale-v1.9.29';
const STATIC_ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/config.js',
  './js/moistureEngine.js',
  './js/sheetsService.js',
  './js/rainpointService.js',
  './js/deviceService.js',
  './js/app.js',
  './assets/logo-mark.png',
  './assets/favicon-32.png',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/apple-touch-icon.png',
  './assets/kh-agrifarm-logo.png',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (
    url.hostname.includes('google.com') ||
    url.hostname.includes('googleusercontent.com') ||
    url.hostname.includes('script.google.com') ||
    url.hostname.includes('firebasedatabase.app')
  ) {
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
