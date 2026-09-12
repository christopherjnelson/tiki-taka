import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("the release version is stable SemVer and the lockfile mirrors it", async () => {
  const [manifest, lockfile] = await Promise.all(
    ["package.json", "package-lock.json"].map(async (file) =>
      JSON.parse(await readFile(new URL(file, root), "utf8")),
    ),
  );

  assert.match(manifest.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.ok(["alpha", "beta"].includes(manifest.releaseStage));
  assert.equal(lockfile.version, manifest.version);
  assert.equal(lockfile.packages?.[""]?.version, manifest.version);
});
