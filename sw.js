/* ========================================================
   KIBANGOUTV - SERVICE WORKER PWA (V2.1.0)
   Network-First pour App Shell/Catalogs & Pass-through Streaming
   ======================================================== */

const CACHE_NAME = "kibangoutv-core-v2.1.0";
const ICON_ASSETS = [
  "/logo.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-192.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
  "/favicon.png"
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ICON_ASSETS)).catch(() => {})
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 1. Pass-through direct pour tous les flux vidéo, API proxy/stream, range et résolution
  if (
    req.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.includes(".m3u8") ||
    url.pathname.includes(".ts") ||
    url.pathname.includes(".mp4") ||
    url.pathname.startsWith("/api/") ||
    url.pathname.includes("/resolve") ||
    url.pathname.includes("/source/") ||
    url.searchParams.has("u") ||
    url.searchParams.has("url") ||
    req.headers.has("range")
  ) {
    return;
  }

  // 2. HTML / App Shell / JS / JSON manifests & catalogs : Network-First (toujours à jour en prod)
  if (
    req.mode === "navigate" ||
    url.pathname === "/" ||
    url.pathname === "/index.html" ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".json") ||
    url.pathname.endsWith(".webmanifest")
  ) {
    event.respondWith(
      fetch(req).then((networkRes) => {
        if (networkRes && networkRes.status === 200) {
          const clone = networkRes.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return networkRes;
      }).catch(() => caches.match(req).then((c) => c || caches.match("/index.html")))
    );
    return;
  }

  // 3. Icônes & images locales statiques : Cache-First avec revalidation
  if (ICON_ASSETS.includes(url.pathname) || url.pathname.endsWith(".png") || url.pathname.endsWith(".svg")) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const net = fetch(req).then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            const clone = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return networkRes;
        }).catch(() => null);
        return cached || net;
      })
    );
    return;
  }
});
