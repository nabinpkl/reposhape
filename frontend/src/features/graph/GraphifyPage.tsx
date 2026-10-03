"use client";

import { useQuery } from "@tanstack/react-query";

import { api, graphifyPageUrl } from "@/lib/api";

/**
 * graphify's own page, framed verbatim.
 *
 * This is the rendering half of the comparison: the extractor tabs draw
 * graphify's edges through our sigma renderer so only the extractor differs;
 * this tab draws graphify's output through graphify's vis-network page so only
 * the rendering differs. Our filters, focus and file pane do not apply here --
 * the page carries its own sidebar, legend and physics -- so the sidebar says
 * so instead of offering controls that do nothing.
 */
export function GraphifyPage({ analysisKey }: { analysisKey: string }) {
  const status = useQuery({
    queryKey: ["graphify-status", analysisKey],
    queryFn: () => api.graphifyStatus(analysisKey),
  });

  if (status.isPending) {
    return <PageNote>Checking for graphify&apos;s page…</PageNote>;
  }
  if (status.error) {
    return <PageNote tone="error">{(status.error as Error).message}</PageNote>;
  }
  if (!status.data.ready) {
    return (
      <PageNote>
        {status.data.reason ?? "graphify's page is not built for this repo."}
      </PageNote>
    );
  }

  return (
    <iframe
      title="graphify's own graph page"
      src={graphifyPageUrl(analysisKey)}
      sandbox="allow-scripts"
      className="absolute inset-0 h-full w-full border-0"
    />
  );
}

function PageNote({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "error";
}) {
  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center">
      <p
        className={
          tone === "error"
            ? "max-w-md rounded border border-danger/40 bg-panel px-3 py-2 text-[12px] text-danger"
            : "max-w-md rounded bg-panel/90 px-3 py-1.5 text-[12px] text-muted"
        }
      >
        {children}
      </p>
    </div>
  );
}
