import { build } from "vite";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const desktopOutput = path.join(projectRoot, "dist", "desktop");
await rm(desktopOutput, { recursive: true, force: true });
await build({ configFile: path.join(projectRoot, "vite.desktop.config.js") });
for (const asset of [
  "manifest.webmanifest",
  "icon.svg",
  "icon-192.png",
  "icon-512.png",
])
  await cp(
    path.join(projectRoot, "public", asset),
    path.join(desktopOutput, asset),
  );
await mkdir(path.join(desktopOutput, "licenses"), { recursive: true });
for (const license of ["Poppins-LICENSE.txt", "Roboto-LICENSE.txt"])
  await cp(
    path.join(projectRoot, "public", "fonts", license),
    path.join(desktopOutput, "licenses", license),
  );

console.log("Built Electron desktop web assets → dist/desktop");
