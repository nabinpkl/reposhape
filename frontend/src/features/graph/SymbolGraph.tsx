"use client";

import { useQuery } from "@tanstack/react-query";

import { api, graphifyPageUrl } from "@/lib/api";

/**
 * The symbol graph: graphify's own page, framed verbatim.
 *
 * This tool extracts files and imports; symbols are graphify's data, drawn by
 * graphify's vis-network page. Our filters, focus and file pane do not apply
 * here -- the page carries its own sidebar, legend and physics -- so the
 * sidebar says so instead of offering controls that do nothing.
 */
export function SymbolGraph({ analysisKey }: { analysisKey: string }) {
  const status = useQuery({
    queryKey: ["graphify-status", analysisKey],
    queryFn: () => api.graphifyStatus(analysisKey),
  });

  if (status.isPending) {
    return <PageNote>Checking for a symbol graph…</PageNote>;
  }
  if (status.error) {
    return <PageNote tone="error">{(status.error as Error).message}</PageNote>;
  }
  if (!status.data.ready) {
    return (
      <PageNote>
        {status.data.reason ?? "No symbol graph is built for this repo."}
      </PageNote>
    );
  }

  return (
    <iframe
      title="Symbol graph, drawn by graphify"
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
