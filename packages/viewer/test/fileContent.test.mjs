import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_TEXT_BYTES, readBrowserFile } from "../dist/index.js";

test("text is read, and cut past the display limit", async () => {
  const short = await readBrowserFile(new File(["one\ntwo\n"], "a.txt"));
  assert.deepEqual(short, { kind: "text", text: "one\ntwo\n", size: 8, truncated: false });

  const long = await readBrowserFile(new File(["x".repeat(MAX_TEXT_BYTES + 10)], "big.txt"));
  assert.equal(long.kind, "text");
  assert.equal(long.text.length, MAX_TEXT_BYTES);
  assert.equal(long.truncated, true);
});

test("a NUL byte in the first block means binary", async () => {
  const content = await readBrowserFile(new File([new Uint8Array([0x89, 0x50, 0x00, 0x47])], "blob.bin"));
  assert.deepEqual(content, { kind: "binary", size: 4 });
});

test("an image becomes an object URL the pane can let go of", async () => {
  const content = await readBrowserFile(new File(["<svg/>"], "i.svg", { type: "image/svg+xml" }));
  assert.equal(content.kind, "image");
  assert.match(content.src, /^blob:/);
  content.dispose();
});
