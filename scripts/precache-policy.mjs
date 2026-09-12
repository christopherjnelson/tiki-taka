/**
 * Install-time service-worker cache policy.
 *
 * Audio is deliberately excluded: it is large, not needed to render the app,
 * and the generated worker's same-origin fetch handler caches it after its
 * first successful playback request. Keep this policy independent of the
 * playlist/sample manifests so adding an audio file cannot silently increase
 * the install download.
 */
export const shouldPrecacheAsset = (asset) =>
  asset !== "./sw.js" && !asset.startsWith("./audio/");
