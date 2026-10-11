// What npm would publish: the build, the README, the LICENSE, the manifest.
// Nothing else, and none of those missing.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

test("the tarball holds exactly the build, the readme and the license", () => {
  const [report] = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" }),
  );
  assert.deepEqual(report.files.map((file) => file.path).sort(), [
    "LICENSE",
    "README.md",
    "dist/index.d.ts",
    "dist/index.js",
    "dist/style.css",
    "package.json",
  ]);
});
