import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

await import("./electron-web.mjs");
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const output = process.env.ELECTRON_OUTPUT || "release/electron";
const child = spawn(
  process.execPath,
  [
    path.join(projectRoot, "node_modules/electron-builder/out/cli/cli.js"),
    "--linux",
    "dir",
    "AppImage",
    "--config.directories.output",
    output,
  ],
  {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
  },
);
await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else if (code)
      reject(new Error(`electron-builder exited with status ${code}`));
    else resolve();
  });
});
