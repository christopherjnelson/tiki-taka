const CACHE = "tiki-taka-v7-desktop-split";
const ASSETS = [
  "./",
  "./index.html",
  "./src/style.css",
  "./src/main.js",
  "./src/game.js",
  "./src/renderer.js",
  "./src/venues.js",
  "./src/settings.js",
  "./src/progress.js",
  "./src/audio.js",
  "./apps/desktop/",
  "./apps/desktop/index.html",
  "./apps/desktop/src/style.css",
  "./apps/desktop/src/main.js",
  "./packages/engine/src/index.js",
  "./packages/engine/src/game.js",
  "./packages/engine/src/progress.js",
  "./packages/engine/src/settings.js",
  "./packages/engine/src/venues.js",
  "./packages/presentation/src/renderer.js",
  "./packages/presentation/src/audio.js",
  "./packages/data/src/index.js",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./public/manifest.webmanifest",
  "./public/icon.svg",
  "./public/icon-192.png",
  "./public/icon-512.png",
  "./public/fonts/display.ttf",
  "./public/fonts/signage.ttf",
];
const development = ["localhost", "127.0.0.1", "[::1]"].includes(
  self.location.hostname,
);
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("tiki-taka-") && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});
self.addEventListener("fetch", (event) => {
  if (
    event.request.method !== "GET" ||
    new URL(event.request.url).origin !== self.location.origin
  )
    return;
  if (development) {
    // Local edits should be visible on refresh; the installed game still works offline.
    event.respondWith(
      fetch(event.request, { cache: "no-store" }).catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        throw new Error("This resource is unavailable offline.");
      }),
    );
  } else {
    event.respondWith(
      caches
        .match(event.request)
        .then((cached) => cached || fetch(event.request)),
    );
  }
});
