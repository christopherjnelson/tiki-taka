import { defineConfig } from "vite";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const packageInfo = JSON.parse(readFileSync(path.resolve("package.json"), "utf8"));

function git(...args) {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

// Only these deliberately public, scalar values are compiled into the client.
// Do not pass import.meta.env through: VITE_ variables can include unrelated
// deployment configuration.
function shortSha(value) {
  const candidate = value?.trim() || "";
  return /^[0-9a-f]{7,40}$/i.test(candidate) ? candidate.slice(0, 12) : "";
}

const ciSha = shortSha(process.env.VITE_BUILD_SHA) || shortSha(process.env.GITHUB_SHA);
const localSha = git("rev-parse", "--short=8", "HEAD");
const sha = ciSha || shortSha(localSha) || "local";
const dirty = !ciSha && Boolean(git("status", "--porcelain"));
const buildNumber = process.env.VITE_BUILD_NUMBER
  || (process.env.GITHUB_RUN_NUMBER
    ? `${process.env.GITHUB_RUN_NUMBER}.${process.env.GITHUB_RUN_ATTEMPT || "1"}`
    : "local");
const buildIdentity = {
  stage: packageInfo.releaseStage === "beta" ? "BETA" : "ALPHA",
  version: packageInfo.version,
  sha: `${sha}${dirty && sha !== "local" ? "-dirty" : ""}`,
  build: /^\d+(\.\d+)?$/.test(buildNumber) ? buildNumber : "local",
};

export default defineConfig({
  root: path.resolve("apps/desktop"),
  // envDir follows `root` by default, which would look for .env inside
  // apps/desktop. The tracked .env.example, .gitignore and the setup docs all
  // put it at the repository root, so point Vite there — otherwise the
  // Supabase configuration is silently dropped and the build falls back to
  // guest-only storage with no sign-in.
  envDir: path.resolve("."),
  base: "./",
  publicDir: false,
  define: {
    __TIKI_TAKA_BUILD__: JSON.stringify(buildIdentity),
  },
  build: {
    target: "es2022",
    outDir: path.resolve("dist/desktop"),
    emptyOutDir: true,
  },
});
