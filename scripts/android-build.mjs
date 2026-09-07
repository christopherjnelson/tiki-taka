import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const env = { ...process.env };
const localJava = path.join(root, ".tooling/jdk21");
const localSdk = path.join(root, ".tooling/android-sdk");
if (!env.JAVA_HOME && existsSync(localJava)) env.JAVA_HOME = localJava;
if (!env.ANDROID_HOME && existsSync(localSdk)) env.ANDROID_HOME = localSdk;
if (!env.GRADLE_USER_HOME && existsSync(path.join(root, ".tooling")))
  env.GRADLE_USER_HOME = path.join(root, ".tooling/gradle");

const windows = process.platform === "win32";
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit", shell: windows });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status || 1);
}
run(windows ? "npm.cmd" : "npm", ["run", "mobile:sync"]);
run(windows ? "gradlew.bat" : "./gradlew", ["assembleDebug", "--console=plain"], path.join(root, "apps/mobile/android"));
console.log("Android APK: apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk");
