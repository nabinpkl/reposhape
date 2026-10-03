"use client";

// Styles are inline rather than imported. This boundary replaces the root
// layout, so it cannot inherit the stylesheet, and pulling the whole Tailwind
// build into a page that renders four elements is the wrong trade for the one
// surface that has to work when everything else has failed.
//
// Colours follow the OS directly (no script, no provider -- both may be what
// failed) through light-dark(): dark values first, matching :root.

/**
 * Recovery is a plain link, not React's `reset()`.
 *
 * A failure caught here happened in the root layout, which is the one place
 * where leaning on that layout's own hydration is least defensible: `reset()`
 * re-runs exactly the render that just failed, and does nothing at all if the
 * scripts behind it never ran. A document navigation needs no script.
 *
 * Providing this file also fixes the build. Next's own `/_global-error` page
 * fails to prerender here with "Expected workStore to be initialized"; supplying
 * a real one takes that generated page out of the build.
 */
export default function GlobalError() {
  return (
    <html lang="en">
      <body
        style={{
          background: "light-dark(#0f0f1a, #eef0f4)",
          color: "light-dark(#e0e0e0, #1f2328)",
          colorScheme: "light dark",
          fontFamily: "-apple-system, BlinkMacSystemFont, system-ui, sans-serif",
          display: "flex",
          minHeight: "100vh",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "12px",
        }}
      >
        <h1 style={{ fontSize: "18px", fontWeight: 600 }}>Something went wrong</h1>
        <p style={{ fontSize: "13px", color: "light-dark(#9a9ab0, #59636e)" }}>
          The analysis on disk is unaffected.
        </p>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages --
            A full document navigation is the point: next/link does a client-side
            router transition, which is unavailable here and the last thing to
            rely on when the shell itself has just failed. */}
        <a href="/" style={{ fontSize: "13px", color: "light-dark(#4e79a7, #34618f)" }}>
          Reload
        </a>
      </body>
    </html>
  );
}
