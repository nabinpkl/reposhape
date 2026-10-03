import Link from "next/link";

/**
 * This app has exactly one route, so reaching here means a hand-typed URL.
 *
 * Supplying it is also what keeps the build green: Next's own generated
 * `/_not-found` fails to prerender in this project with "Expected workStore to
 * be initialized", and an authored page replaces it. Same reason
 * `global-error.tsx` exists.
 */
export default function NotFound() {
  return (
    <main className="grid h-dvh place-items-center bg-canvas text-fg">
      <div className="text-center">
        <p className="text-[13px] text-muted">Nothing here.</p>
        <Link href="/" className="mt-2 inline-block text-[13px] text-accent hover:underline">
          Back to the graph
        </Link>
      </div>
    </main>
  );
}
