import { build } from "vite";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { SAMPLE_FILES } from "../apps/desktop/src/samples.js";
import { shouldPrecacheAsset } from "./precache-policy.mjs";

await rm("dist", { recursive: true, force: true });
await build({ configFile: path.resolve("vite.desktop.config.js") });
for (const asset of [
  "manifest.webmanifest",
  "icon.svg",
  "icon-192.png",
  "icon-512.png",
])
  await cp(path.join("public", asset), path.join("dist/desktop", asset));
// The soundtrack itself is no longer copied into the build: tracks are
// fetched at runtime from a manifest served outside the release (see
// apps/desktop/src/manifest.js and public/audio/manifest.json for the local
// dev copy). Only the sampled effects below — small, few, and needed for the
// build's own sound design — still ship as build assets. dist/desktop/audio/
// only exists at all if there are effects to put in it: the mkdir below is
// recursive and makes both levels.
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
// Audio is downloaded on demand instead of during installation. The fetch
// handler below caches same-origin responses, so every track/effect becomes
// available offline after its first successful request.
// The entry HTML decides which JS is "the shell": anything it references is
// needed to render, anything it does not is a deferred chunk that the fetch
// handler can cache on first use instead.
const entryHtml = await readFile("dist/desktop/index.html", "utf8");
const precacheAssets = desktopAssets.filter((asset) => shouldPrecacheAsset(asset, entryHtml));
const serviceWorker = `const CACHE = "tiki-taka-desktop-${cacheVersion}";
const ASSETS = ${JSON.stringify(precacheAssets, null, 2)};
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener("activate", event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("tiki-taka-desktop-") && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener("fetch", event => { if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return; event.respondWith(caches.match(event.request).then(hit => hit || fetch(event.request).then(response => { if (response.ok) { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, copy)); } return response; }).catch(() => event.request.mode === "navigate" ? caches.match("./index.html") : Response.error()))); });
`;
await writeFile("dist/desktop/sw.js", serviceWorker);
console.log("Built → dist/desktop");
