"use client";

import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * Whether this page is served read-only: the public deployment, where the
 * server does not register the routes that clone, analyse, refresh or forget.
 *
 * The server enforces that by not having the routes; this only keeps the page
 * from offering buttons that would answer 404. Unknown counts as read-only, so
 * a public page never flashes controls it is about to take away, and the
 * personal tool shows them one health request later.
 */
export function useReadOnly(): boolean {
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, staleTime: Infinity });
  return health.data?.read_only ?? true;
}
