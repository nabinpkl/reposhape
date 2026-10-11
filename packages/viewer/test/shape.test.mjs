// Run against the build, the code consumers get: `pnpm build && pnpm test`.
import assert from "node:assert/strict";
import { test } from "node:test";

import { OTHER_COLOR, PALETTE, kindOf, toShape } from "../dist/index.js";

test("files with no group are grouped by extension, commonest first", () => {
  const shape = toShape({
    files: [{ path: "a.ts" }, { path: "b/c.ts" }, { path: "d.md" }, { path: "Makefile" }, { path: ".gitignore" }],
  });
  assert.deepEqual(
    shape.groups.map((group) => [group.label, group.size, group.color]),
    [
      [".ts", 2, PALETTE[0]],
      [".gitignore", 1, PALETTE[1]],
      [".md", 1, PALETTE[2]],
      ["no extension", 1, PALETTE[3]],
    ],
  );
  assert.deepEqual(
    shape.items.map((item) => item.group),
    [0, 0, 2, 3, 1],
  );
});

test("past the palette, groups share the overflow colour and say so", () => {
  const files = Array.from({ length: 12 }, (_, index) => ({ path: `f${index}.e${index}` }));
  const shape = toShape({ files });
  assert.equal(shape.groups.length, 12);
  assert.ok(shape.groups.slice(0, 10).every((group) => group.distinct));
  assert.ok(shape.groups.slice(10).every((group) => group.color === OTHER_COLOR && !group.distinct));
});

test("given groups keep their order and colours, and null means no group", () => {
  const shape = toShape({
    files: [
      { path: "x.py", group: "b" },
      { path: "y.py", group: null },
      { path: "z.py", group: "a" },
      { path: "w.py", group: "missing" },
    ],
    groups: [
      { id: "a", label: "Alpha", color: "#112233" },
      { id: "b" },
    ],
  });
  assert.deepEqual(
    shape.groups.map((group) => [group.key, group.label, group.color]),
    [
      ["a", "Alpha", "#112233"],
      ["b", "b", PALETTE[0]],
    ],
  );
  assert.deepEqual(
    shape.items.map((item) => item.group),
    [1, null, 0, null],
  );
});

test("sizes: absent means no size view, present floors at half the median", () => {
  assert.equal(toShape({ files: [{ path: "a" }, { path: "b" }] }).hasSizes, false);
  const sized = toShape({ files: [10, 20, 40, 1000].map((size, index) => ({ path: `f${index}`, size })) });
  assert.equal(sized.hasSizes, true);
  assert.equal(sized.sizeFloor, 20);
  assert.equal(toShape({ files: [{ path: "a", size: 5 }], sizeFloor: 70 }).sizeFloor, 70);
});

test("kindOf names a file's kind", () => {
  assert.equal(kindOf("src/Index.TS"), ".ts");
  assert.equal(kindOf("a/.env"), ".env");
  assert.equal(kindOf("LICENSE"), "no extension");
  assert.equal(kindOf("trailing."), "no extension");
});
