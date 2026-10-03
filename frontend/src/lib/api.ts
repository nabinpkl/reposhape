import { config } from "@/lib/config";
import type {
  Analysis,
  AnalysisSource,
  FileContents,
  FolderListing,
  GraphifyPageStatus,
  GraphView,
  Health,
  RepoLicense,
  RuntimeLink,
  RepoPaths,
  RepoSummary,
  SourceOption,
} from "@/generated/contracts";

/**
 * Every call into the backend. Typed by the generated contracts, which come
 * from the same Pydantic models the CLI writes its JSON with.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(detail);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${config.apiOrigin}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    // The server's `detail` is the only useful part of a FastAPI error, and a
    // stale artifact answers 409 with a sentence worth showing verbatim.
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch {
      // A non-JSON error body is still an error; the status line stands.
    }
    throw new ApiError(response.status, detail);
  }
  return (await response.json()) as T;
}

/** What a refresh did to the checkout, for a repo this tool cloned itself. */
export type UpdateOutcome = "updated" | "current" | "left_alone" | "failed";

export interface UpdateReport {
  outcome: UpdateOutcome;
  detail: string | null;
  sha: string | null;
}

export interface AnalyzeResponse {
  key: string;
  summary: RepoSummary;
  stats_duration_ms: number;
  from_cache: boolean;
  /** Null unless this tool cloned the repo: nothing else is ever fetched. */
  update: UpdateReport | null;
}

export interface CloneResponse {
  path: string;
  already_present: boolean;
}

export const api = {
  repos: () => request<RepoSummary[]>("/api/repos"),

  /**
   * What this server is. `read_only` is the public deployment, which has no
   * operator routes; otherwise both roots, and `clone_root` is where a cloned
   * repo lands and stays.
   */
  health: () => request<Health>("/api/health"),

  /**
   * Put a remote repo on this machine and answer with its path. Cloning and
   * analysing stay two calls: the clone is the slow networked half and happens
   * once, and the analysis that follows is the same one every folder gets.
   */
  clone: (url: string) =>
    request<CloneResponse>("/api/clone", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),

  /**
   * Take a repository out of the picker: its artifact for every source, and the
   * pages drawn from each. Answers with every key removed, which is what a
   * caller needs to move off whichever of them is on screen.
   */
  forget: (key: string) => request<string[]>(`/api/repos/${key}`, { method: "DELETE" }),

  analyze: (repoPath: string, source: AnalysisSource = "imports", refresh = false) =>
    request<AnalyzeResponse>("/api/analyze", {
      method: "POST",
      body: JSON.stringify({ repo_path: repoPath, source, refresh }),
    }),

  /**
   * Child directories of `path`, for picking a folder to analyse. Completion is
   * a shell's: a path ending in `/` lists it, anything else lists its parent
   * filtered by the last segment. Directories only, never a file.
   */
  folders: (path: string) =>
    request<FolderListing>(`/api/folders?path=${encodeURIComponent(path)}`),

  /** Which extractors this repo can be graphed with, and which are already built. */
  sources: (key: string) => request<SourceOption[]>(`/api/sources/${key}`),

  analysis: (key: string) => request<Analysis>(`/api/analysis/${key}`),

  /** Every path in the repo, for the filter tree. Independent of the filter. */
  paths: (key: string) => request<RepoPaths>(`/api/paths/${key}`),

  graph: (key: string, shape: GraphShape) => {
    return request<GraphView>(`/api/graph/${key}?${shapeParams(shape)}`);
  },

  file: (key: string, path: string) =>
    request<FileContents>(`/api/file/${key}?path=${encodeURIComponent(path)}`),

  /** Runtime links (ADR-0009) with `path` at either end, whatever the filter. */
  links: (key: string, path: string, includeTests: boolean) =>
    request<RuntimeLink[]>(
      `/api/links/${key}?path=${encodeURIComponent(path)}&include_tests=${includeTests}`,
    ),

  /** The license nearest above `path` and its copyright lines, read from disk now. */
  license: (key: string, path: string) =>
    request<RepoLicense>(`/api/license/${key}?path=${encodeURIComponent(path)}`),

  /** Can graphify's own page be shown for this repo, and what builds it. */
  graphifyStatus: (key: string) => request<GraphifyPageStatus>(`/api/graphify-status/${key}`),

  /** Can the file-level graphify rendering be shown for this analysis. */
  graphifyFilesStatus: (key: string) =>
    request<GraphifyPageStatus>(`/api/graphify-files-status/${key}`),
};

/** graphify's `graph.html` as its own pipeline wrote it. Same-origin, so it frames. */
export function graphifyPageUrl(key: string): string {
  return `/api/graphify-page/${key}`;
}

/** This analysis drawn by graphify's own exporter. Same-origin, so it frames. */
export function graphifyFilesUrl(key: string, shape: GraphShape): string {
  return `/api/graphify-files/${key}?${shapeParams(shape)}`;
}

/** The server-side half of the filter model. See features/filters/filterStore. */
export interface GraphShape {
  excluded: string[];
  includeTests: boolean;
  includeTypeOnly: boolean;
  excludedExtensions: string[];
}

/** One serializer for every shape-carrying URL: ours and graphify files. */
export function shapeParams(shape: GraphShape): URLSearchParams {
  const params = new URLSearchParams();
  for (const path of shape.excluded) params.append("exclude", path);
  for (const ext of shape.excludedExtensions) params.append("exclude_ext", ext);
  params.set("include_tests", String(shape.includeTests));
  params.set("include_type_only", String(shape.includeTypeOnly));
  return params;
}
