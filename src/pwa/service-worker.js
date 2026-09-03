const CACHE_NAME = "__MEP_CACHE_NAME__";
const PRECACHE = __MEP_PRECACHE__;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names.filter((name) => name.startsWith("enplace-shell-") && name !== CACHE_NAME).map((name) => caches.delete(name))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "MEP_ACTIVATE_UPDATE") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) return response;
      } catch {
        // Fall through to the cached app shell while offline.
      }
      const cache = await caches.open(CACHE_NAME);
      return (await cache.match("/")) || (await cache.match("/index.html")) || Response.error();
    })());
    return;
  }

  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
});
