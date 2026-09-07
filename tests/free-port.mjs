import { createServer } from "node:net";

// Ask the OS for an unused TCP port: listening on port 0 makes the kernel pick
// one that is genuinely free right now. Suites use this instead of a hardcoded
// default so two concurrent runs never share a server — a fixed port lets the
// second run reuse the first run's server and assert against the wrong build.
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(error => (error ? reject(error) : resolve(port)));
    });
  });
}
