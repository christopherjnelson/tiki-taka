// Optional local benchmark. This intentionally has no pass/fail performance
// budgets: browser and host contention make a fixed threshold misleading.
// It only fails when the desktop game cannot be measured at all.
import { accessSync, constants } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freePort } from "./free-port.mjs";

const browserName = process.env.BROWSER || "chromium";
if (browserName !== "chromium")
  throw new Error("test:perf currently requires Chromium for long-task collection.");
const sampleDuration = Number(process.env.PERF_DURATION_MS || 5000);
if (!Number.isFinite(sampleDuration) || sampleDuration < 1000)
  throw new Error("PERF_DURATION_MS must be a number of at least 1000.");

const root = fileURLToPath(new URL("..", import.meta.url));
const defaultOutput = path.join(root, "test-results", "desktop-performance.json");
const output = path.resolve(process.env.PERF_OUTPUT || defaultOutput);
const playwright = await import(process.env.PLAYWRIGHT_MODULE || "@playwright/test");
const baseURL = process.env.BASE_URL || `http://localhost:${await freePort()}`;
const browserCandidates = [
  process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  "/opt/google/chrome/chrome",
].filter(Boolean);
const executablePath = browserCandidates.find(candidate => {
  try { accessSync(candidate, constants.X_OK); return true; } catch { return false; }
});

let server;
async function ensureServer() {
  try {
    const response = await fetch(baseURL);
    if (response.ok) return;
  } catch {}
  const url = new URL(baseURL);
  server = spawn(process.execPath, ["scripts/serve.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: url.port || "5173",
      SERVE_DIR: path.join(root, "dist", "desktop"),
    },
    stdio: "ignore",
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    try { if ((await fetch(baseURL)).ok) return; } catch {}
  }
  throw new Error(`Could not start benchmark server at ${baseURL}`);
}

function percentile(values, value) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)];
}

function rounded(value, digits = 2) {
  return value == null ? null : Number(value.toFixed(digits));
}

function summarizeLongTasks(durations, scope) {
  return {
    scope,
    count: durations.length,
    totalMs: rounded(durations.reduce((total, duration) => total + duration, 0)),
    maxMs: rounded(Math.max(0, ...durations)),
  };
}

let browser;
try {
  await ensureServer();
  browser = await playwright.chromium.launch({
    headless: process.env.HEADED !== "1",
    ...(executablePath && { executablePath }),
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: "block",
  });
  await context.addInitScript(() => {
    window.__desktopPerformance = { longTasks: [] };
    if ("PerformanceObserver" in window) {
      try {
        new PerformanceObserver(list => {
          for (const entry of list.getEntries())
            window.__desktopPerformance.longTasks.push(entry.duration);
        }).observe({ type: "longtask", buffered: true });
      } catch {}
    }
  });
  const page = await context.newPage();
  const errors = [];
  const expectedNetworkWarnings = [];
  const isBlockedSupabaseRequest = text =>
    text.includes("supabase.co") &&
    (text.includes("connect-src") || text.includes("Fetch API cannot load"));
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() !== "error") return;
    const text = message.text();
    // A production bundle built with local optional Supabase values can make
    // leaderboard requests while the local static server deliberately permits
    // only origins supplied to that server process. That configuration warning
    // is outside the desktop render workload and must not hide real failures.
    if (isBlockedSupabaseRequest(text)) expectedNetworkWarnings.push(text);
    else errors.push(text);
  });

  await page.goto(`${baseURL}/`, { waitUntil: "networkidle" });
  await page.locator("#home-view").waitFor({ state: "visible" });
  const homeLoadLongTasks = await page.evaluate(() =>
    window.__desktopPerformance.longTasks.splice(0),
  );
  await page.locator("#title-play").click();
  await page.locator("#arena-view").waitFor({ state: "visible" });
  const arenaReadyLongTasks = await page.evaluate(() =>
    window.__desktopPerformance.longTasks.splice(0),
  );
  await page.locator("#start-button").click();
  await page.locator("#game-overlay").waitFor({ state: "hidden" });
  // wall-clock: this is sampling PerformanceObserver long-task entries over a
  // real elapsed window to let one-time startup work (bundle parse, first
  // paint) drain out of the sample before the sustained-scene measurement
  // below begins - it is a genuine timer window, not a per-frame condition.
  await page.waitForTimeout(1000);
  const warmupLongTasks = await page.evaluate(() => {
    const durations = window.__desktopPerformance.longTasks.splice(0);
    // Keep the scenario in the active arena for the whole sample. These test
    // values prevent defender, held-ball, and match-clock transitions without
    // changing production code or removing renderer/AI update work.
    window.__game.grace = Number.MAX_SAFE_INTEGER;
    window.__game.hold = 0;
    window.__game.time = Number.MAX_SAFE_INTEGER;
    return durations;
  });
  await page.keyboard.down("ArrowRight");
  const sample = await page.evaluate(async duration => {
    const intervals = [];
    let previous = performance.now();
    const stopAt = previous + duration;
    await new Promise(resolve => {
      const tick = now => {
        intervals.push(now - previous);
        previous = now;
        // Run after the game's own animation callback and keep possession
        // pressure representative without letting the six-second hold rule
        // end a long sample. A negative/infinite hold would corrupt the
        // defender-speed calculation in Game.update().
        window.__game.hold = 0;
        if (now < stopAt) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    const navigation = performance.getEntriesByType("navigation")[0];
    const fcp = performance.getEntriesByName("first-contentful-paint")[0];
    return {
      intervals,
      navigation: navigation && {
        domContentLoaded: navigation.domContentLoadedEventEnd,
        load: navigation.loadEventEnd,
        response: navigation.responseEnd - navigation.requestStart,
        transferSize: navigation.transferSize,
      },
      firstContentfulPaint: fcp?.startTime ?? null,
      longTasks: window.__desktopPerformance?.longTasks || [],
    };
  }, sampleDuration);
  await page.keyboard.up("ArrowRight");
  const stillPlaying = await page.evaluate(() => {
    const game = window.__game;
    return (
      game?.status === "playing" &&
      game.players.every(
        player => Number.isFinite(player.x) && Number.isFinite(player.y),
      ) &&
      game.defenders.every(
        defender => Number.isFinite(defender.x) && Number.isFinite(defender.y),
      ) &&
      document.body.classList.contains("play-view") &&
      document.querySelector("#game-overlay")?.hidden &&
      document.querySelector("#resume-prompt")?.hidden
    );
  });
  if (!stillPlaying)
    throw new Error("Benchmark left the active arena before the sample completed.");
  if (errors.length) throw new Error(`Browser errors during benchmark: ${errors.join("; ")}`);

  const frames = sample.intervals.slice(1);
  if (frames.length < 20) throw new Error("Too few animation frames collected for a useful baseline.");
  const result = {
    schemaVersion: 2,
    measuredAt: new Date().toISOString(),
    browser: browserName,
    viewport: { width: 1440, height: 1000 },
    sampleDurationMs: sampleDuration,
    navigationMs: Object.fromEntries(Object.entries(sample.navigation || {}).map(([key, value]) => [key, rounded(value)])),
    firstContentfulPaintMs: rounded(sample.firstContentfulPaint),
    framePacingMs: {
      samples: frames.length,
      mean: rounded(frames.reduce((sum, value) => sum + value, 0) / frames.length),
      p50: rounded(percentile(frames, 0.5)),
      p95: rounded(percentile(frames, 0.95)),
      p99: rounded(percentile(frames, 0.99)),
      over33ms: frames.filter(value => value > 33.34).length,
      over50ms: frames.filter(value => value > 50).length,
    },
    longTasks: {
      homeLoad: summarizeLongTasks(
        homeLoadLongTasks,
        "navigation through home-ready state",
      ),
      arenaReady: summarizeLongTasks(
        arenaReadyLongTasks,
        "home-to-arena transition through arena-ready state",
      ),
      arenaWarmup: summarizeLongTasks(
        warmupLongTasks,
        "start action and one-second arena warmup",
      ),
      interactiveSample: summarizeLongTasks(
        sample.longTasks,
        "post-warmup interactive sample",
      ),
    },
    expectedNetworkWarnings: expectedNetworkWarnings.length,
  };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log("Desktop performance baseline (informational; no budgets enforced)");
  console.table({
    "FCP (ms)": result.firstContentfulPaintMs,
    "Load (ms)": result.navigationMs.load,
    "Frame mean / p95 (ms)": `${result.framePacingMs.mean} / ${result.framePacingMs.p95}`,
    "Frames >33 / >50ms": `${result.framePacingMs.over33ms} / ${result.framePacingMs.over50ms}`,
    "Long tasks home / ready / warmup / sample":
      `${result.longTasks.homeLoad.count} / ` +
      `${result.longTasks.arenaReady.count} / ` +
      `${result.longTasks.arenaWarmup.count} / ` +
      `${result.longTasks.interactiveSample.count}`,
  });
  if (expectedNetworkWarnings.length)
    console.warn(`Ignored ${expectedNetworkWarnings.length} optional Supabase CSP warnings from the local static server.`);
  console.log(`Full JSON: ${output}`);
  await context.close();
} finally {
  await browser?.close();
  server?.kill();
}
