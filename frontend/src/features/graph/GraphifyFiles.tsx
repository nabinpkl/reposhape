"use client";

import { useQuery } from "@tanstack/react-query";

import { api, graphifyFilesUrl } from "@/lib/api";
import { useGraphShape } from "@/features/filters/filterStore";

/**
 * graphify's renderer over file-level data, framed verbatim.
 *
 * The sibling `GraphifyPage` is graphify's artifact as its pipeline wrote it:
 * symbols, package names, community names like `Equatable`. This one is the
 * same vis-network renderer over this analysis instead: one node per file, one
 * edge per import, our partition and labels. Same drawing engine, no symbols.
 *
 * The iframe src carries the shape, so this pane filters exactly like ours:
 * the server trims the exported page's embedded data with the same keep set.
 */
export function GraphifyFiles({ analysisKey }: { analysisKey: string }) {
  const { shape } = useGraphShape();
  const status = useQuery({
    queryKey: ["graphify-files-status", analysisKey],
    queryFn: () => api.graphifyFilesStatus(analysisKey),
  });

  if (status.isPending) {
    return <PageNote>Drawing files with graphify&apos;s renderer…</PageNote>;
  }
  if (status.error) {
    return <PageNote tone="error">{(status.error as Error).message}</PageNote>;
  }
  if (!status.data.ready) {
    return (
      <PageNote>
        {status.data.reason ?? "graphify's renderer is not installed here."}
      </PageNote>
    );
  }

  return (
    <iframe
      title="graphify's renderer over files"
      src={graphifyFilesUrl(analysisKey, shape)}
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
            ? "max-w-md rounded border border-danger/40 bg-panel px-3 py-1.5 text-[12px] text-danger"
            : "max-w-md rounded bg-panel/90 px-3 py-1.5 text-[12px] text-muted"
        }
      >
        {children}
      </p>
    </div>
  );
}
