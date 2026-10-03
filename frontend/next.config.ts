import type { NextConfig } from "next";

/**
 * Two shapes, one flag.
 *
 * The shipped shape is a static export (`just web-export`): plain files that
 * FastAPI serves beside `/api` from one origin, in `reposhape up` and in the public
 * deployment alike (ADR-0008). Nothing in the page needs a Next server -- it is
 * one client-rendered route over an API -- so there is no Node at run time.
 *
 * The other shape is `just web`, the frontend developer's hot-reloading dev
 * server. It rewrites `/api/*` to FastAPI so the browser still sees one origin
 * and no CORS surface exists. Rewrites cannot exist in an export, which is why
 * the flag chooses between the two rather than both being set.
 */
const exporting = process.env.REPOSHAPE_WEB_EXPORT === "1";

/** The dev server's backend. Named once, here, and never reaches the browser. */
const backendOrigin = process.env.REPOSHAPE_API_ORIGIN ?? "http://127.0.0.1:7420";

/**
 * Origins the dev server answers besides localhost, comma separated: a
 * tailnet MagicDNS wildcard such as `*.example.ts.net`, a LAN address.
 */
const extraDevOrigins = (process.env.REPOSHAPE_DEV_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  ...(exporting
    ? {
        output: "export",
        // `/curve-probe/` as `curve-probe/index.html`, which a static file
        // server finds by directory; `curve-probe.html` it would not.
        trailingSlash: true,
      }
    : {
        async rewrites() {
          return [{ source: "/api/:path*", destination: `${backendOrigin}/api/:path*` }];
        },
      }),
  experimental: {
    // Turbopack's dev filesystem cache is off because it does not bound
    // itself. Measured 2026-09-14: three days of `reposhape up` grew
    // `.next/dev/cache/turbopack` to 542MB across 1,431 files (717 SST
    // segments) while its own LOG showed three live ones, nothing ever
    // compacted the rest away, and the dev server then held 804 of them open
    // and burned 480-600% CPU indefinitely at idle with no browser attached
    // and nothing in the log. Deleting the store dropped it to 0.0% and 14
    // open files; restoring the store byte for byte reproduced the burn, so
    // it is the store and not this app. What the cache buys here is 0.4s:
    // cold start is Ready 361ms and 581ms to the first page, warm is 285ms
    // and 270ms. A tool that sits open all day cannot pay five cores for that.
    turbopackFileSystemCacheForDev: false,
  },
  // The dev server is reached at 127.0.0.1 as well as localhost (browser
  // harnesses use the literal address), and on some machines over a tailnet
  // MagicDNS name or a LAN address -- and Next refuses to boot the client
  // runtime across any boundary it is not told about, leaving inert server
  // HTML with no error anywhere. Measured: over any non-allowlisted origin no
  // mount effect ran (no queries, no listeners) while the same page on
  // localhost was fully alive. A tailnet wildcard names the tailnet,
  // `*.example.ts.net`, never `*.ts.net`: Next's matcher only lets `*` cover
  // exactly one label, so the shorter pattern never matches a three-label
  // MagicDNS name (verified against its own isCsrfOriginAllowed).
  allowedDevOrigins: ["127.0.0.1", ...extraDevOrigins],
};

export default config;
