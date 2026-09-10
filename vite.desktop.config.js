import { defineConfig } from "vite";
import path from "node:path";

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
  build: {
    target: "es2022",
    outDir: path.resolve("dist/desktop"),
    emptyOutDir: true,
  },
});
