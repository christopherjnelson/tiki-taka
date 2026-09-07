import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

let displayNumber = 90;
while (existsSync(`/tmp/.X11-unix/X${displayNumber}`)) displayNumber++;
const display = `:${displayNumber}`;
const xvfb = spawn(
  "Xvfb",
  [display, "-screen", "0", "1440x900x24", "-nolisten", "tcp"],
  {
    stdio: ["ignore", "pipe", "pipe"],
  },
);
const children = [xvfb];
const stop = () => {
  for (const child of children) if (!child.killed) child.kill("SIGTERM");
};
process.once("exit", stop);
process.once("SIGINT", () => process.exit(130));
process.once("SIGTERM", () => process.exit(143));
await new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, 500);
  xvfb.once("error", reject);
  xvfb.once("exit", (code) => {
    clearTimeout(timer);
    reject(new Error(`Xvfb exited before startup with status ${code}`));
  });
});
const isolatedEnv = {
  ...process.env,
  DISPLAY: display,
  XDG_SESSION_TYPE: "x11",
  TIKI_TAKA_ISOLATED_TEST: "1",
};
delete isolatedEnv.WAYLAND_DISPLAY;
const wm = spawn("icewm", [], {
  env: isolatedEnv,
  stdio: ["ignore", "pipe", "pipe"],
});
children.push(wm);
await new Promise((resolve) => setTimeout(resolve, 500));
const test = spawn(process.execPath, ["tests/electron.browser.mjs"], {
  env: isolatedEnv,
  stdio: "inherit",
});
children.push(test);
const status = await new Promise((resolve, reject) => {
  test.once("error", reject);
  test.once("exit", (code, signal) => resolve({ code, signal }));
});
stop();
if (status.signal) process.kill(process.pid, status.signal);
if (status.code) process.exit(status.code);
