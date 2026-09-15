import { defineConfig } from "vite";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseChangelog } from "./scripts/changelog.mjs";

const packageInfo = JSON.parse(readFileSync(path.resolve("package.json"), "utf8"));
// Baked at build/dev time from the committed CHANGELOG.md, never fetched at
// runtime (the app must work offline behind the service worker) - see the
// header comment on scripts/changelog.mjs and CHANGELOG.md itself for the
// "updates on releases, not PRs" contract this depends on. A dev build that
// is not itself a release still gets a real changelog: whatever is
// currently committed to CHANGELOG.md, which is exactly the released
// history to date - there is no separate "unreleased" entry to fake.
const changelog = parseChangelog(readFileSync(path.resolve("CHANGELOG.md"), "utf8"));

// Keep the source shell annotated for maintainers, but do not ship those
// developer-only notes in the production app shell.
const stripDeveloperHtmlComments = {
  name: "strip-developer-html-comments",
  apply: "build",
  transformIndexHtml: {
    order: "post",
    handler: (html) => html.replace(/<!--[\s\S]*?-->/g, ""),
  },
};

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
  plugins: [stripDeveloperHtmlComments],
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
    __TIKI_TAKA_CHANGELOG__: JSON.stringify(changelog),
  },
  build: {
    target: "es2022",
    outDir: path.resolve("dist/desktop"),
    emptyOutDir: true,
  },
});
