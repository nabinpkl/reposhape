"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

import { highlighter, languageOf } from "@/features/file-view/highlighter";
import { cn } from "@/lib/class-names";

/**
 * A file's text with line numbers, highlighted when its extension has a
 * grammar. Where the text came from is the caller's business: the repo's file
 * pane fetches it, the folder view reads it off a picked file.
 */
export function CodeBlock({ path, text }: { path: string; text: string }) {
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
  // tokens. Both grammars load once; switching scheme re-highlights.
  const { resolvedTheme } = useTheme();
  const scheme = resolvedTheme === "light" ? "light" : "dark";

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
      className={cn(
        "code-lines font-mono text-[11.5px] leading-[1.55]",
        "[&_pre]:!bg-transparent [&_pre]:p-3",
        "[&_code]:block [&_code]:w-max [&_code]:min-w-full",
      )}
      // Shiki output, built from file text it escaped itself. The text
      // never reaches innerHTML unescaped.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  ) : (
    // No grammar for this extension: the same gutter as the Shiki path
    // (w-10 + mr-4 + faint), one row per line. The row keeps its height
    // from the number, so empty lines need no placeholder.
    <pre className="w-max min-w-full p-3 font-mono text-[11.5px] leading-[1.55] text-fg">
      {text.split("\n").map((line, index) => (
        <div key={index} className="flex">
          <span
            aria-hidden
            className="mr-4 inline-block w-10 shrink-0 text-right text-faint select-none"
          >
            {index + 1}
          </span>
          <span className="whitespace-pre">{line}</span>
        </div>
      ))}
    </pre>
  );
}
