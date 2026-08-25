const CACHE_NAME = "panelview-shell-v1";
const CACHE_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./manifest.webmanifest",
  "./main.js",
  "./zip.js",
  "./detect.js",
  "./comicsol.js",
  "./reader.js",
  "./app.js",
  "./demo/demo.json",
  "./demo/page-001.jpg",
  "./demo/page-002.jpg",
  "./demo/page-003.jpg",
  "./sw.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(CACHE_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
    )),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request)),
  );
});

/* Register only static shell assets. User comic blobs stay runtime-only. */
