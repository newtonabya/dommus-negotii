"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { resendGuaranteeAction } from "./actions";

/**
 * Loan Officer: "Send the request (again)" to the guarantor. While SMS is off
 * and the guarantor has no email, the link is shown here to hand over in
 * person or send to the guarantor's own WhatsApp. Never shown to the applicant.
 */
export function GuaranteeRequestButton({ loanId, again }: { loanId: string; again: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "ok" | "error"; message: string; link: string | null } | null>(null);
  const [copied, setCopied] = useState(false);

  async function send() {
    setBusy(true);
    setCopied(false);
    const r = await resendGuaranteeAction(loanId);
    setBusy(false);
    setResult(r.ok ? { tone: "ok", ...r.value } : { tone: "error", message: r.error, link: null });
    if (r.ok) router.refresh();
  }

  return (
    <div className="mt-1 flex flex-col gap-1 text-sm">
      <div>
        <button type="button" className="underline disabled:opacity-50" disabled={busy} onClick={() => void send()}>
          {busy ? "Sending…" : again ? "Send the request again" : "Send the request"}
        </button>
      </div>
      {result ? (
        <div role="status" className={result.tone === "error" ? "text-danger" : "text-muted"}>
          {result.message}
          {result.link ? (
            <span className="mt-1 flex flex-col gap-1">
              <code className="break-all rounded-md bg-background p-2 text-xs text-foreground">{result.link}</code>
              <span>
                <button
                  type="button"
                  className="underline"
                  onClick={() =>
                    void navigator.clipboard.writeText(result.link as string).then(
                      () => setCopied(true),
                      () => setCopied(false),
                    )
                  }
                >
                  {copied ? "Copied" : "Copy link"}
                </button>{" "}
                · Only the guarantor should open it. It works once, for 7 days.
              </span>
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
