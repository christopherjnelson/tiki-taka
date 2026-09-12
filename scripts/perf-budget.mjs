/**
 * Optional production bundle/asset budget check.
 *
 * Run `npm run perf:bundle` locally before a release. It deliberately is not
 * included in `npm test` or `test:web`: it builds the production directory and
 * is a release-performance signal, not a correctness gate.
 */
import { brotliCompressSync, gzipSync } from "node:zlib";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve("dist/desktop");
const check = process.argv.includes("--check");

async function filesAt(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesAt(path.join(directory, entry.name), relative)));
    } else {
      files.push(relative);
    }
  }
  return files;
}

const files = await filesAt(root);
const sizes = new Map();
for (const file of files) sizes.set(file, await readFile(path.join(root, file)));

const bytes = (names) =>
  names.reduce((total, name) => total + (sizes.get(name)?.byteLength || 0), 0);
const compressed = (names, algorithm) =>
  names.reduce(
    (total, name) => total + algorithm(sizes.get(name)).byteLength,
    0,
  );
const shell = files.filter(
  (file) =>
    file === "index.html" ||
    file.endsWith(".js") ||
    file.endsWith(".css"),
);
const tracks = files.filter(
  (file) => file.startsWith("audio/") && !file.startsWith("audio/effects/"),
);
const fonts = files.filter(
  (file) => file.endsWith(".woff2") || file.endsWith(".ttf"),
);
// Read the generated ASSETS array rather than restating its policy here. This
// ensures the reported precache size is exactly what cache.addAll() receives.
const worker = sizes.get("sw.js")?.toString("utf8");
const assetsMatch = worker?.match(/const ASSETS = (\[[\s\S]*?\]);\nself\.addEventListener\("install"/);
if (!assetsMatch) throw new Error("Could not read generated service-worker precache assets");
const precache = JSON.parse(assetsMatch[1]).map((asset) => asset.slice(2));
const total = bytes(files);
const shellGzip = compressed(shell, gzipSync);
const shellBrotli = compressed(shell, brotliCompressSync);
const precacheBytes = bytes(precache);

const format = (value) => `${(value / 1024).toFixed(1)} KiB`;
console.log("Production asset measurement (dist/desktop)");
console.table([
  { metric: "HTML/CSS/JS raw", value: format(bytes(shell)) },
  { metric: "HTML/CSS/JS gzip", value: format(shellGzip) },
  { metric: "HTML/CSS/JS Brotli", value: format(shellBrotli) },
  { metric: "font assets (raw)", value: format(bytes(fonts)) },
  { metric: "service-worker precache (raw)", value: format(precacheBytes) },
  { metric: "all soundtrack tracks (raw)", value: format(bytes(tracks)) },
  { metric: "complete delivered build (raw)", value: format(total) },
]);

// These intentionally cover only highly compressible app-shell code. Audio
// has separate reporting because Ogg files are already compressed and is a
// product/content decision, not an accidental JavaScript regression.
const budgets = [
  { name: "HTML/CSS/JS gzip", actual: shellGzip, limit: 140 * 1024 },
  { name: "font assets", actual: bytes(fonts), limit: 220 * 1024 },
  { name: "service-worker precache", actual: precacheBytes, limit: 1024 * 1024 },
];
if (check) {
  const exceeded = budgets.filter((budget) => budget.actual > budget.limit);
  for (const budget of budgets)
    console.log(
      `${budget.name}: ${format(budget.actual)} / ${format(budget.limit)}`,
    );
  if (exceeded.length) {
    console.error(`Budget exceeded: ${exceeded.map((budget) => budget.name).join(", ")}`);
    process.exitCode = 1;
  }
}
