import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  platform: "browser",
  dts: true,
  // Every export is a client component or feeds one. The directive keeps a
  // Next.js server component able to import the package without wrapping it.
  banner: { js: '"use client";' },
  copy: [{ from: "src/style.css", to: "dist" }],
});
