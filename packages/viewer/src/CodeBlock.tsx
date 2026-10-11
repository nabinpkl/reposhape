import { useEffect, useState } from "react";

import type { ColorScheme } from "./colors";
import { highlighter, languageOf } from "./highlighter";

/**
 * A file's text with line numbers, highlighted when its extension has a
 * grammar. Where the text came from is the caller's business: a server, a
 * picked file, a string in memory.
 *
 * Carries its own `rs-viewer` root, so it is styled by the package stylesheet
 * wherever it is mounted, inside `FilePane` or not.
 */
export function CodeBlock({
  path,
  text,
  theme = "dark",
}: {
  /** Decides the grammar, by extension. */
  path: string;
  text: string;
  theme?: ColorScheme;
}) {
  // The highlighted result carries the path, the text AND the scheme it was
  // produced for, and is only rendered when all three still match. Clearing it
  // synchronously at the top of the effect instead would show the previous
  // file's code for a frame and costs an extra render pass; keying it is both
  // correct and cheaper.
  const [highlighted, setHighlighted] = useState<{
    path: string;
    text: string;
    scheme: "dark" | "light";
    html: string;
  } | null>(null);

  // Shiki carries its own theme because its colours are inline styles, not
  // variables. Both themes load once; switching scheme re-highlights.
  const scheme = theme;

  useEffect(() => {
    const language = languageOf(path);
    if (!language) return;
    let live = true;
    void highlighter().then((instance) => {
      if (!live) return;
      setHighlighted({
        path,
        text,
        scheme,
        html: instance.codeToHtml(text, {
          lang: language,
          theme: scheme === "light" ? "github-light-default" : "github-dark-default",
        }),
      });
    });
    return () => {
      live = false;
    };
  }, [path, text, scheme]);

  const html =
    highlighted?.path === path && highlighted.text === text && highlighted.scheme === scheme
      ? highlighted.html
      : null;

  return html ? (
    <div
      className="rs-viewer rs-code"
      data-theme={theme}
      // Shiki output, built from file text it escaped itself. The text
      // never reaches innerHTML unescaped.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  ) : (
    // No grammar for this extension: the same gutter as the Shiki path, one
    // row per line. The row keeps its height from the number, so empty lines
    // need no placeholder.
    <div className="rs-viewer rs-code" data-theme={theme}>
      <pre className="rs-plain">
        {text.split("\n").map((line, index) => (
          <div key={index} className="rs-plain-line">
            <span aria-hidden className="rs-gutter">
              {index + 1}
            </span>
            <span>{line}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}
