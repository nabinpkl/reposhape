import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CodeBlock } from "../dist/index.js";

const rows = (text) =>
  renderToStaticMarkup(createElement(CodeBlock, { path: "notes.md", text })).match(/rs-plain-line/g)?.length ?? 0;

test("plain text numbers the lines an editor would, not the trailing newline", () => {
  assert.equal(rows("one\ntwo\n"), 2);
  assert.equal(rows("one\ntwo"), 2);
  assert.equal(rows("one\n\nthree\n"), 3);
  assert.equal(rows(""), 0);
});
