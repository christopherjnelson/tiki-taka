// The development server. This runs Vite rather than the static server in
// serve.mjs, because only Vite substitutes import.meta.env — without it the
// Supabase configuration never reaches the browser and the app silently runs
// guest-only, with no sign-in offered. serve.mjs remains the way to serve a
// finished build (SERVE_DIR), which is what the browser suites use.
import path from "node:path";
import { createServer, loadEnv } from "vite";

const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || "localhost";
const repoRoot = path.resolve(".");

// Read the same environment Vite will expose to the client, from the same
// directory (see envDir in vite.desktop.config.js), so the policy below can
// name the exact Supabase origin the adapter is going to call.
const env = loadEnv("development", repoRoot, "");
let supabaseConnectSource = "";
try {
  const value = env.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  if (value) {
    const parsed = new URL(value);
    if (parsed.protocol === "https:") supabaseConnectSource = ` ${parsed.origin}`;
  }
} catch {
  // An invalid optional URL simply leaves the strict self-only policy intact.
}

// Development needs a looser policy than production: Vite injects its client
// and hot-update code, and talks to itself over a websocket. This policy is
// therefore NOT the one the app ships with — the production policy lives in
// the document's meta tag and in serve.mjs, and neither is changed by this
// file. frame-ancestors still comes from a header, since a meta tag cannot
// deliver it.
const devPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  `connect-src 'self' ws: wss:${supabaseConnectSource}`,
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

const devSecurityPolicy = {
  name: "tiki-taka-dev-security-policy",
  // Serve only: a build must never pick this relaxed policy up.
  apply: "serve",
  transformIndexHtml(html) {
    // The document ships a strict production policy in a meta tag. Left as-is
    // it would block Vite's own client, so swap it for the development policy
    // while serving. The file on disk is untouched.
    return html.replace(
      /<meta http-equiv="Content-Security-Policy"[\s\S]*?\/?>/i,
      `<meta http-equiv="Content-Security-Policy" content="${devPolicy}" />`,
    );
  },
  configureServer(server) {
    server.middlewares.use((_request, response, next) => {
      response.setHeader("Content-Security-Policy", devPolicy);
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Referrer-Policy", "no-referrer");
      next();
    });
  },
};

const server = await createServer({
  configFile: path.resolve("vite.desktop.config.js"),
  plugins: [devSecurityPolicy],
  server: {
    port,
    host,
    strictPort: true,
    // The app's root is apps/desktop but it imports the shared packages from
    // their sibling directories, so the dev server has to be allowed to read
    // the whole repository.
    fs: { allow: [repoRoot] },
  },
});

await server.listen();
const shown = host === "0.0.0.0" ? "localhost" : host;
console.log(`tiki-taka → http://${shown}:${port}`);
console.log(
  supabaseConnectSource
    ? `Supabase configured → ${supabaseConnectSource.trim()}`
    : "No Supabase configuration found — running guest-only, no sign-in offered.",
);
