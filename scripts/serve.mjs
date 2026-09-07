import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
const root = path.resolve(process.env.SERVE_DIR || ".");
const servingBuild = Boolean(process.env.SERVE_DIR);
const port = Number(process.env.PORT || 5173);
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
  ".apk": "application/vnd.android.package-archive",
};
const appSource = (relative, app) =>
  relative === path.join("apps", app, "index.html") ||
  relative.startsWith(path.join("apps", app, "src") + path.sep);
const publicFile = (relative) =>
  relative === "index.html" ||
  relative === "sw.js" ||
  ["manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png"].includes(
    relative,
  ) ||
  relative.startsWith(`assets${path.sep}`) ||
  relative.startsWith(`licenses${path.sep}`) ||
  relative.startsWith(`src${path.sep}`) ||
  relative.startsWith(`public${path.sep}`) ||
  appSource(relative, "desktop") ||
  appSource(relative, "mobile") ||
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
      if (!servingBuild && (pathname === "/apk" || pathname === "/apk/")) {
        res.writeHead(302, {
          Location: "/public/downloads/tiki-taka-debug.apk",
          "Cache-Control": "no-store",
        }).end();
        return;
      }
      const aliasedPath =
        pathname === "/mobile" || pathname === "/mobile/"
          ? "/apps/mobile/index.html"
          : pathname.startsWith("/mobile/")
            ? `/apps/mobile/${pathname.slice(8)}`
            : !servingBuild &&
                [
                  "/manifest.webmanifest",
                  "/icon.svg",
                  "/icon-192.png",
                  "/icon-512.png",
                ].includes(pathname)
              ? `/public${pathname}`
              : pathname;
      const requestPath =
        aliasedPath === "/"
          ? "/index.html"
          : aliasedPath.endsWith("/")
            ? `${aliasedPath}index.html`
            : aliasedPath;
      const file = path.resolve(root, "." + requestPath);
      if (!file.startsWith(root + path.sep)) {
        res.writeHead(403).end();
        return;
      }
      if (!publicFile(path.relative(root, file))) {
        res.writeHead(404).end("Not found");
        return;
      }
      if (!(await stat(file)).isFile()) throw new Error("not a file");
      res.writeHead(200, {
        "Content-Type": types[path.extname(file)] || "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404).end("Not found");
    }
  })
  .listen(port, process.env.HOST || "127.0.0.1", () =>
    console.log(`tiki-taka → http://localhost:${port}`),
  );
