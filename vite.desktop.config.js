import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  root: path.resolve("apps/desktop"),
  base: "./",
  publicDir: false,
  build: {
    target: "es2022",
    outDir: path.resolve("dist/desktop"),
    emptyOutDir: true,
  },
});
