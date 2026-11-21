"use client";

import { useState } from "react";
import { Alert, Button } from "@/components/ui/form";
import { issueSignInLinkAction } from "../actions";

type Link = { url: string; qr: string; expiresAt: string; firstTime: boolean };

/** Loan Officer: make a one-time link the member uses to set their password, with no SMS code. */
export function SignInLinkCard({ memberId, firstName }: { memberId: string; firstName: string }) {
  const [link, setLink] = useState<Link | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function make() {
    setBusy(true);
    setError(null);
    setCopied(false);
    const result = await issueSignInLinkAction(memberId);
    setBusy(false);
    if (result.ok) setLink(result.value);
    else setError(result.error);
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch {
      setError("Couldn't copy. Select the link and copy it by hand.");
    }
  }

  const until = link ? new Date(link.expiresAt).toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Lagos" }) : "";

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div>
        <h2 className="text-lg font-semibold">Sign-in link</h2>
        <p className="text-sm text-muted">
          For a member who can&apos;t get an SMS code: they open the link and choose a password. Check their ID first. The link works once, for 30
          minutes, and making a new one cancels the last.
        </p>
      </div>
      {link ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          {/* eslint-disable-next-line @next/next/no-img-element -- a data URL made on the server */}
          <img src={link.qr} alt={`QR code of ${firstName}'s sign-in link`} width={180} height={180} className="rounded-md border border-border bg-white" />
          <div className="flex min-w-0 flex-col gap-2 text-sm">
            <p>
              {firstName} can scan this, or you can send the link by WhatsApp to their own number. It works until <strong>{until}</strong>.
              {link.firstTime ? " They'll also accept the data protection notice." : " Their old password stops working."}
            </p>
            <code className="break-all rounded-md bg-background p-2 text-xs">{link.url}</code>
            <div className="flex flex-wrap gap-3">
              <Button type="button" variant="secondary" onClick={copy}>
                {copied ? "Copied" : "Copy link"}
              </Button>
              <Button type="button" variant="secondary" onClick={make} disabled={busy}>
                {busy ? "Making…" : "Make a new link"}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div>
          <Button type="button" onClick={make} disabled={busy}>
            {busy ? "Making…" : "Make a sign-in link"}
          </Button>
        </div>
      )}
      {error ? <Alert tone="error">{error}</Alert> : null}
    </section>
  );
}
