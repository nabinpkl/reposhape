import type { HighlighterCore } from "shiki/core";

/**
 * One highlighter for the app, created on first use.
 *
 * Shiki loads a WASM regex engine and a grammar per language, so creating one
 * per file view would re-pay that on every click. The languages are the ones
 * the analyser can produce plus the assets it reports; anything else renders as
 * plain text rather than failing.
 */
const GRAMMARS = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  css: () => import("shiki/langs/css.mjs"),
};

type Language = keyof typeof GRAMMARS;

const ALIASES: Record<string, Language> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  vue: "vue",
  py: "python",
  pyi: "python",
  json: "json",
  css: "css",
};

let pending: Promise<HighlighterCore> | null = null;

/**
 * Fine-grained rather than `import("shiki")`: the full bundle puts every
 * grammar and theme shiki has into the static export as its own chunk, about
 * three hundred files the page never loads, all of which the Python package
 * then ships and its third-party notices would have to answer for. These are
 * the only grammars and themes that reach the export.
 */
export function highlighter(): Promise<HighlighterCore> {
  if (!pending) {
    pending = Promise.all([import("shiki/core"), import("shiki/engine/oniguruma")]).then(
      ([{ createHighlighterCore }, { createOnigurumaEngine }]) =>
        createHighlighterCore({
          themes: [
            import("shiki/themes/github-dark-default.mjs"),
            import("shiki/themes/github-light-default.mjs"),
          ],
          langs: Object.values(GRAMMARS).map((load) => load()),
          engine: createOnigurumaEngine(import("shiki/wasm")),
        }),
    );
  }
  return pending;
}

export function languageOf(path: string): Language | null {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return ALIASES[extension] ?? null;
}
