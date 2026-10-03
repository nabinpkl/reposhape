#!/usr/bin/env node
/**
 * The license notices for the browser code the Python package ships.
 *
 * The wheel carries the static export, which is minified copies of React,
 * sigma, shiki and the rest. Their licenses (MIT, ISC, Apache-2.0, ...) let
 * that happen on condition that each copyright and permission notice travels
 * with the copy, so this writes a notices file into the export, and the
 * package build refuses to run without it (backend/hatch_build.py). Node
 * rather than Python because the image's frontend stage has no Python.
 *
 * Which packages: the production closure of the frontend's direct
 * dependencies, except that `next` contributes only itself and `@swc/helpers`.
 * The rest of Next's closure (sharp, libvips, caniuse-lite, postcss, the SWC
 * binaries) runs at build time and never reaches the export; listing it would
 * claim the wheel distributes an LGPL library it does not. Over-inclusion
 * inside the closure is accepted: a radix primitive the page never imports
 * costs a paragraph here.
 *
 * A package with neither a license file nor a license field fails the run.
 *
 *   node tools/third_party_notices.mjs <output file>
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), "..", "frontend");

// Next's dependencies that its client runtime imports into the export.
const NEXT_CLIENT_RUNTIME = ["@swc/helpers"];

const LICENSE_STEMS = ["license", "licence", "copying"];
const NOTICE_STEMS = ["notice"];

// shiki's grammar and theme packages are MIT under shiki's own copyright, but
// each grammar was written upstream under another. These are the upstream
// holders for what highlighter.ts imports (the vue grammar pulls in html, css,
// javascript, typescript, json and four vue sub-grammars), as listed by
// shikijs/textmate-grammars-themes. Importing a new language means adding its
// origin here.
const GRAMMAR_ORIGINS = `Language grammars and colour themes bundled through @shikijs/langs and
@shikijs/themes (MIT License, full text above), written upstream as:

- typescript, tsx, javascript, jsx, python, json, css, html, html-derivative:
  microsoft/vscode, MIT License, Copyright (c) 2015 - present Microsoft Corporation
- vue, markdown-vue, vue-directives, vue-interpolations,
  vue-sfc-style-variable-injection: vuejs/language-tools, MIT License,
  Copyright (c) 2021-present Johnson Chu
- github-dark-default, github-light-default: primer/github-vscode-theme,
  MIT License, Copyright (c) 2020 Primer`;

function directDependencies() {
  const listing = execFileSync("pnpm", ["list", "--prod", "--depth", "Infinity", "--json"], {
    cwd: FRONTEND,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const [project] = JSON.parse(listing);
  return project.dependencies;
}

function shipped(direct) {
  const found = new Map();
  const walk = (name, node, descend = true) => {
    const key = `${name}@${node.version}`;
    if (found.has(key)) return;
    found.set(key, { name, version: node.version, path: node.path });
    if (!descend) return;
    for (const [child, childNode] of Object.entries(node.dependencies ?? {})) {
      walk(child, childNode);
    }
  };
  for (const [name, node] of Object.entries(direct)) {
    if (name === "next") {
      walk(name, node, false);
      for (const runtime of NEXT_CLIENT_RUNTIME) walk(runtime, node.dependencies[runtime]);
    } else {
      walk(name, node);
    }
  }
  return [...found.values()].sort((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
  );
}

// Some packages ship CRLF license files; the notices file is one text.
const readText = (file) => readFileSync(file, "utf8").replace(/\r\n?/g, "\n").trim();

function filesNamed(directory, stems) {
  return readdirSync(directory)
    .filter((entry) => stems.includes(entry.toLowerCase().split(".")[0]))
    .map((entry) => join(directory, entry))
    .filter((path) => statSync(path).isFile())
    .sort();
}

function section({ name, version, path }) {
  const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
  const declared =
    typeof manifest.license === "object" ? manifest.license?.type : manifest.license;
  const texts = filesNamed(path, LICENSE_STEMS).map(readText);
  const notices = filesNamed(path, NOTICE_STEMS).map(readText);
  if (texts.length === 0 && !declared) {
    throw new Error(`${name}@${version}: no license file and no license field in ${path}`);
  }
  const lines = [`${name} ${version}`, `License: ${declared ?? "see text below"}`];
  if (manifest.homepage) lines.push(`Homepage: ${manifest.homepage}`);
  const body =
    texts.length > 0
      ? texts.join("\n\n")
      : `(No license file is shipped with this package; it declares ${declared}.)`;
  return [lines.join("\n"), body, ...notices].join("\n\n");
}

const output = process.argv[2];
if (!output) {
  console.error("usage: node tools/third_party_notices.mjs <output file>");
  process.exit(2);
}
const sections = shipped(directDependencies()).map(section);
const header = `Third-party software in reposhape's browser client

The page this package serves is a static build that includes the
following ${sections.length} packages. Their notices are reproduced below as
their licenses require. Generated by tools/third_party_notices.mjs.
`;
const rule = `\n\n${"-".repeat(78)}\n\n`;
writeFileSync(output, `${header}${rule}${[...sections, GRAMMAR_ORIGINS].join(rule)}\n`);
console.error(`wrote ${output} (${sections.length} packages)`);
