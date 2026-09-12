import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("generated service worker precaches the app shell but no audio", async () => {
  const worker = await readFile(new URL("../dist/desktop/sw.js", import.meta.url), "utf8");
  const match = worker.match(/const ASSETS = (\[[\s\S]*?\]);\nself\.addEventListener\("install"/);
  assert.ok(match, "generated worker must expose its install-time asset list");
  const assets = JSON.parse(match[1]);
  assert.ok(assets.includes("./index.html"));
  assert.ok(assets.some((asset) => asset.startsWith("./assets/")));
  assert.ok(assets.every((asset) => !asset.startsWith("./audio/")));
});
