import { build } from "vite";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { TRACK_FILES } from "../apps/desktop/src/playlist.js";
import { SAMPLE_FILES } from "../apps/desktop/src/samples.js";

await rm("dist", { recursive: true, force: true });
await build({ configFile: path.resolve("vite.desktop.config.js") });
for (const asset of [
  "manifest.webmanifest",
  "icon.svg",
  "icon-192.png",
  "icon-512.png",
])
  await cp(path.join("public", asset), path.join("dist/desktop", asset));
// The soundtrack lives in a subdirectory, so it needs the folder made first.
// The list comes from apps/desktop/src/playlist.js rather than being repeated
// here: a duplicated list drifted from it once and shipped a build with no
// audio at all.
await mkdir("dist/desktop/audio", { recursive: true });
for (const track of TRACK_FILES)
  await cp(
    path.join("public/audio", track),
    path.join("dist/desktop/audio", track),
  );
// Sampled effects, from the same kind of list for the same reason
// (apps/desktop/src/samples.js). The list is normally empty; a file named
// there but missing from public/audio/effects is reported and skipped rather
// than failing the build, so a half-finished drop still produces a playable
// build — the game falls back to the synthesised effect.
if (SAMPLE_FILES.length) {
  await mkdir("dist/desktop/audio/effects", { recursive: true });
  for (const sample of SAMPLE_FILES)
    try {
      await cp(
        path.join("public/audio/effects", sample),
        path.join("dist/desktop/audio/effects", sample),
      );
    } catch {
      console.warn(
        `! public/audio/effects/${sample} is listed in apps/desktop/src/samples.js but missing; the synthesised effect stays`,
      );
    }
}
await mkdir("dist/desktop/licenses", { recursive: true });
for (const license of ["Poppins-LICENSE.txt", "Roboto-LICENSE.txt"])
  await cp(
    path.join("public/fonts", license),
    path.join("dist/desktop/licenses", license),
  );

async function filesAt(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "sw.js") continue;
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory())
      files.push(
        ...(await filesAt(path.join(directory, entry.name), relative)),
      );
    else files.push(`./${relative}`);
  }
  return files;
}

const desktopAssets = await filesAt("dist/desktop");
const cacheHash = createHash("sha256");
for (const asset of desktopAssets) {
  cacheHash.update(asset);
  cacheHash.update(await readFile(path.join("dist/desktop", asset.slice(2))));
}
const cacheVersion = cacheHash.digest("hex").slice(0, 12);
// The soundtrack is 17+MB across six tracks but the app shell is ~150KB, so
// precaching every track at install means a first-time visitor downloads the
// whole soundtrack before they've heard track two. Only the track the
// playlist opens on (apps/desktop/src/playlist.js, TRACKS[0]) is precached;
// the rest are ordinary same-origin GETs that the fetch handler below caches
// the first time the playlist reaches them, so a track played once is
// available offline afterward without paying for the other five up front.
const otherTracks = new Set(
  TRACK_FILES.slice(1).map((track) => `./audio/${track}`),
);
const precacheAssets = desktopAssets.filter(
  (asset) => !otherTracks.has(asset),
);
const serviceWorker = `const CACHE = "tiki-taka-desktop-${cacheVersion}";
const ASSETS = ${JSON.stringify(precacheAssets, null, 2)};
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener("activate", event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("tiki-taka-desktop-") && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener("fetch", event => { if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return; event.respondWith(caches.match(event.request).then(hit => hit || fetch(event.request).then(response => { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, copy)); return response; }).catch(() => event.request.mode === "navigate" ? caches.match("./index.html") : Response.error()))); });
`;
await writeFile("dist/desktop/sw.js", serviceWorker);
console.log("Built → dist/desktop");
