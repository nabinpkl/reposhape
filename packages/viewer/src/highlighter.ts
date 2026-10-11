import type { HighlighterCore } from "shiki/core";

/**
 * One highlighter per page, created on the first file shown.
 *
 * Shiki compiles a grammar per language, so creating one per file view would
 * re-pay that on every click. The languages are the source and asset kinds
 * reposhape analyses; anything else renders as plain text rather than failing.
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
 * three hundred files a page never loads. These are the only grammars and
 * themes a consumer's bundle gets, each as a chunk loaded on first use.
 */
export function highlighter(): Promise<HighlighterCore> {
  if (!pending) {
    pending = Promise.all([import("shiki/core"), import("shiki/engine/javascript")]).then(
      ([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) =>
        createHighlighterCore({
          themes: [
            import("shiki/themes/github-dark-default.mjs"),
            import("shiki/themes/github-light-default.mjs"),
          ],
          langs: Object.values(GRAMMARS).map((load) => load()),
          // Not the Oniguruma WASM engine: compiling WASM needs a CSP that
          // allows 'wasm-unsafe-eval', which a strict page policy does not.
          // Strict, so a grammar this engine cannot run fails loudly here.
          engine: createJavaScriptRegexEngine(),
        }),
    );
  }
  return pending;
}

export function languageOf(path: string): Language | null {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return ALIASES[extension] ?? null;
}
