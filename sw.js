/* ========================================================
   KIBANGOUTV - SERVICE WORKER PWA (V1.2.0)
   Mise en cache intelligente de l'App Shell & Pass-through Streaming
   ======================================================== */

const CACHE_NAME = "kibangoutv-core-v1.2.0";
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/logo.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-192.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
  "/favicon.png",
  "/manifest.webmanifest",
  "/manifest.json"
];

// Installation : Mise en cache initiale de l'App Shell
self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
});

// Activation : Nettoyage automatique des anciens caches
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

// Interception des requêtes réseau
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 1. NE JAMAIS INTERCEPTER NI METTRE EN CACHE LES FLUX VIDÉO ET APPELS DE PROXY
  // (Évite les saturations de quota de stockage et les latences sur le direct)
  if (
    req.method !== "GET" ||
    url.pathname.includes(".m3u8") ||
    url.pathname.includes(".ts") ||
    url.pathname.startsWith("/api/proxy") ||
    url.pathname.startsWith("/kibangou-addon/resolve") ||
    url.pathname.startsWith("/resolve") ||
    url.searchParams.has("url") ||
    req.headers.has("range")
  ) {
    return;
  }

  // 2. Navigation de pages (HTML / App Shell) : Réseau en priorité, repli sur le cache hors-ligne
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => {
        return caches.match("/index.html") || caches.match("/");
      })
    );
    return;
  }

  // 3. Fichiers statiques et icônes : Cache First avec rafraîchissement en arrière-plan
  if (
    STATIC_ASSETS.includes(url.pathname) ||
    url.pathname.endsWith(".png") ||
    url.pathname.endsWith(".svg") ||
    url.pathname.endsWith(".webmanifest") ||
    url.pathname.endsWith(".json")
  ) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const fetchPromise = fetch(req).then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            const resClone = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
          }
          return networkRes;
        }).catch(() => null);

        return cached || fetchPromise;
      })
    );
    return;
  }

  // 4. Par défaut : Réseau standard
  event.respondWith(fetch(req));
});
