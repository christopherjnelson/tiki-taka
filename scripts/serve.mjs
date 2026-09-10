import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
const root = path.resolve(process.env.SERVE_DIR || ".");
const servingBuild = Boolean(process.env.SERVE_DIR);
const port = Number(process.env.PORT || 5173);
// The deployed browser can call just its configured Supabase project. Keep
// this origin exact rather than loosening connect-src to all of Supabase.
// Vite exposes VITE_SUPABASE_* to the client; this server only reads the URL
// to mirror that origin in its development/preview CSP header.
let supabaseConnectSource = "";
try {
  const value = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  if (value) {
    const parsed = new URL(value);
    if (parsed.protocol === "https:") supabaseConnectSource = ` ${parsed.origin}`;
  }
} catch {
  // An invalid optional URL simply leaves the strict self-only policy intact.
}
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ttf": "font/ttf",
  ".txt": "text/plain",
};
// The page also carries a CSP meta tag, but a meta element cannot deliver
// frame-ancestors, so only this header gives dev and preview builds
// clickjacking protection.
const securityHeaders = {
  "Content-Security-Policy":
    `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'${supabaseConnectSource}; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
const rootAssets = [
  "manifest.webmanifest",
  "icon.svg",
  "icon-192.png",
  "icon-512.png",
];
const appSource = (relative, app) =>
  relative === path.join("apps", app, "index.html") ||
  relative.startsWith(path.join("apps", app, "src") + path.sep);
const publicFile = (relative) =>
  relative === "index.html" ||
  // The root redirect page loads this instead of an inline script, which the
  // Content-Security-Policy above would block.
  relative === "redirect.js" ||
  // The generated worker only exists in a build; there is no dev-time sw.js.
  (servingBuild && relative === "sw.js") ||
  rootAssets.includes(relative) ||
  relative.startsWith(`assets${path.sep}`) ||
  // The built desktop output carries the soundtrack beside index.html, and the
  // generated service worker precaches it, so a build served from dist has to
  // be able to hand it over or the offline install fails.
  relative.startsWith(`audio${path.sep}`) ||
  relative.startsWith(`licenses${path.sep}`) ||
  relative.startsWith(`src${path.sep}`) ||
  relative.startsWith(`public${path.sep}`) ||
  appSource(relative, "desktop") ||
  relative.startsWith(path.join("packages", "engine", "src") + path.sep) ||
  relative.startsWith(
    path.join("packages", "presentation", "src") + path.sep,
  ) ||
  relative.startsWith(path.join("packages", "data", "src") + path.sep);
http
  .createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(
        new URL(req.url, "http://localhost").pathname,
      );
      // The dev server hosts the desktop page at /apps/desktop/, so its
      // page-relative asset links arrive prefixed; the build serves them from
      // the root beside index.html and needs no alias.
      const devAsset = servingBuild
        ? undefined
        : rootAssets.find(
            (name) =>
              pathname === `/${name}` || pathname === `/apps/desktop/${name}`,
          );
      const aliasedPath = devAsset ? `/public/${devAsset}` : pathname;
      const requestPath =
        aliasedPath === "/"
          ? "/index.html"
          : aliasedPath.endsWith("/")
            ? `${aliasedPath}index.html`
            : aliasedPath;
      const file = path.resolve(root, "." + requestPath);
      if (!file.startsWith(root + path.sep)) {
        res.writeHead(403, securityHeaders).end();
        return;
      }
      if (!publicFile(path.relative(root, file))) {
        res.writeHead(404, securityHeaders).end("Not found");
        return;
      }
      if (!(await stat(file)).isFile()) throw new Error("not a file");
      res.writeHead(200, {
        ...securityHeaders,
        "Content-Type": types[path.extname(file)] || "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404, securityHeaders).end("Not found");
    }
  })
  .listen(port, process.env.HOST || "127.0.0.1", () =>
    console.log(`tiki-taka → http://localhost:${port}`),
  );
