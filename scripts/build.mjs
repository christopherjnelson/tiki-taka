import { build } from "vite";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { TRACK_FILES } from "../apps/desktop/src/playlist.js";

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
const serviceWorker = `const CACHE = "tiki-taka-desktop-${cacheVersion}";
const ASSETS = ${JSON.stringify(desktopAssets, null, 2)};
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener("activate", event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("tiki-taka-desktop-") && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener("fetch", event => { if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return; event.respondWith(caches.match(event.request).then(hit => hit || fetch(event.request).then(response => { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, copy)); return response; }).catch(() => event.request.mode === "navigate" ? caches.match("./index.html") : Response.error()))); });
`;
await writeFile("dist/desktop/sw.js", serviceWorker);
console.log("Built → dist/desktop");
