import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const snapshot = JSON.parse(await readFile(path.join(root, "docs/mobile-freeze-1.1.1.json"), "utf8"));
const changed = [];
for (const [file, expected] of Object.entries(snapshot.files)) {
  try {
    const actual = createHash("sha256").update(await readFile(path.join(root, file))).digest("hex");
    if (actual !== expected) changed.push(file);
  } catch {
    changed.push(file);
  }
}
if (changed.length) {
  console.error(`Frozen mobile/engine sources changed:\n${changed.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Mobile ${snapshot.version} and shared engine match the frozen baseline (${Object.keys(snapshot.files).length} files).`);
}
