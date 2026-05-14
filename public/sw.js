const CACHE = 'divault-v108';
const ASSETS = ['/', '/app.html', '/styles.css?v=108', '/app.js?v=108', '/manifest.webmanifest', '/assets/icon.svg'];
const ASSET_PATHS = new Set(ASSETS);

function cacheableRequest(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return false;
  return request.mode === 'navigate' || ASSET_PATHS.has(url.pathname);
}

function cacheableResponse(response) {
  return response && response.ok && response.type === 'basic';
}

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()).catch(() => {}));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()).catch(() => {}));
});
self.addEventListener('fetch', event => {
  if (!cacheableRequest(event.request)) return;
  event.respondWith(fetch(event.request).then(response => {
    if (cacheableResponse(response)) {
      event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, response.clone())).catch(() => {}));
    }
    return response;
  }).catch(() => event.request.mode === 'navigate' ? caches.match('/app.html').then(match => match || caches.match('/')) : caches.match(event.request)));
});
