/**
 * Install-time service-worker cache policy.
 *
 * Two kinds of asset are deliberately excluded, for the same reason: neither
 * is needed to render the app, and the generated worker's same-origin fetch
 * handler caches both after their first successful request.
 *
 * Audio is large and optional. Keep this policy independent of the
 * playlist/sample manifests so adding an audio file cannot silently increase
 * the install download.
 *
 * Deferred JavaScript chunks are excluded for the same reason and one more:
 * precaching a chunk the page never statically imports undoes the point of
 * splitting it out. The Supabase client is ~56 KiB gzipped and is loaded only
 * when a player actually signs in - a guest who never does should not download
 * it at install any more than they download it on first paint. A chunk counts
 * as deferred when index.html does not reference it, which is exactly the set
 * Vite leaves out of the entry's static graph.
 */
export function shouldPrecacheAsset(asset, entryHtml = "") {
  if (asset === "./sw.js") return false;
  if (asset.startsWith("./audio/")) return false;
  if (asset.endsWith(".js")) return entryHtml.includes(asset.slice(2));
  return true;
}
