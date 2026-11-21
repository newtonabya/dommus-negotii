"use client";

import Link from "next/link";
import { StatusScreen, primaryLinkClass, secondaryLinkClass } from "@/components/status-screen";

/** Any page that fails to load: a calm message, a retry, and the reference staff can look up in the logs. */
export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  const digest = error instanceof Error && "digest" in error ? String((error as Error & { digest?: string }).digest ?? "") : "";
  return (
    <StatusScreen
      title="Something went wrong"
      actions={
        <>
          <button type="button" onClick={() => retry()} className={primaryLinkClass}>
            Try again
          </button>
          <Link href="/" className={secondaryLinkClass}>
            Go to your home page
          </Link>
        </>
      }
    >
      <p>This page could not be loaded. Try again in a moment. If you were saving something, check whether it went through before you send it again.</p>
      {digest ? (
        <p className="mt-3 text-xs">
          If it keeps happening, tell MOAUM this reference: <span className="font-mono font-semibold text-foreground">{digest}</span>
        </p>
      ) : null}
    </StatusScreen>
  );
}
