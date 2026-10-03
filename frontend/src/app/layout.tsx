import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { Providers } from "@/app/providers";

import "@/app/globals.css";

export const metadata: Metadata = {
  title: "reposhape",
  description: "The file-level import graph of your own code.",
};

/** Phones get the real viewport, not a 980px minisite, or nothing below is true. */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // No theme class here: next-themes' blocking script sets `dark`/`light` on
  // <html> before first paint, and a hardcoded class would both flash and
  // hydrate against it. suppressHydrationWarning is its documented companion:
  // the script's whole job is to make the attribute differ from SSR.
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
