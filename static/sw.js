self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open('eagleice-v1').then((cache) => cache.addAll([
      '/',
      '/static/style.css',
      '/static/custom.js',
      '/static/icon.svg',
      '/static/manifest.json',
      '//unpkg.com/globe.gl',
      '//cdnjs.cloudflare.com/ajax/libs/satellite.js/4.0.0/satellite.min.js'
    ]))
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.url.includes('/api/')) {
    // API calls bypass cache
    e.respondWith(fetch(e.request));
  } else {
    e.respondWith(
      caches.match(e.request).then((res) => res || fetch(e.request))
    );
  }
});
