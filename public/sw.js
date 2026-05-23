const CACHE = 'divault-v283';
const ASSETS = ['/', '/app.html', '/styles.css?v=283', '/app.js?v=283', '/manifest.webmanifest', '/assets/divault-logo.svg', '/assets/icon.svg'];
const ASSET_PATHS = new Set(ASSETS.map(asset => new URL(asset, self.location.origin).pathname));

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

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = event.notification.data && event.notification.data.url ? event.notification.data.url : '/';
  let url = self.location.origin + '/';
  try {
    const target = new URL(targetUrl, self.location.origin);
    url = target.origin === self.location.origin ? target.href : url;
  } catch (err) {}

  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
    const sameOriginClient = clients.find(client => {
      try { return new URL(client.url).origin === self.location.origin; }
      catch (err) { return false; }
    });
    if (sameOriginClient) return sameOriginClient.focus().then(client => client.navigate ? client.navigate(url) : client);
    return self.clients.openWindow(url);
  }));
});
