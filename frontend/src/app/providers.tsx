"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useState, type ReactNode } from "react";

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // An analysis is a snapshot of a commit. It does not go stale while
            // you look at it, and re-fetching on every window focus would throw
            // away a graph layout mid-read.
            staleTime: Infinity,
            refetchOnWindowFocus: false,
            retry: false,
          },
        },
      }),
  );
  // next-themes owns the `dark`/`light` class on <html>: a blocking script it
  // injects resolves stored choice over OS preference before first paint, so
  // there is no flash. `system` is the default; an explicit pick persists in
  // localStorage under its own key.
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </ThemeProvider>
  );
}
