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
    // Cache-first: only an installed worker updates the shell, so HTML and its hashed
    // assets always come from the same release.
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match("/index.html", { ignoreVary: true });
      if (cached) return cached;
      try { return await fetch(request); } catch { return Response.error(); }
    })());
    return;
  }

  // Static files: cache-first. Anything fetched on demand is cached for next time,
  // so the precache can stay small.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request, { ignoreVary: true });
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok && /^\/(?:assets|fonts|samples)\//.test(url.pathname)) event.waitUntil(cache.put(request, response.clone()));
    return response;
  })());
});
