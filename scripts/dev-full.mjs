// Runs the web dev server and the accounts/leaderboard server together for
// local development. Zero dependencies: just two child processes whose
// output is prefixed and whose lifetimes are tied together.
import { spawn } from "node:child_process";

function run(name, command, args) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  const prefix = (line) => `[${name}] ${line}`;
  for (const stream of [child.stdout, child.stderr]) {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) console.log(prefix(line));
    });
  }
  return child;
}

const web = run("web", "node", ["scripts/serve.mjs"]);
const api = run("api", "node", ["server/src/index.js"]);

function shutdown() {
  web.kill();
  api.kill();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
web.on("exit", shutdown);
api.on("exit", shutdown);
