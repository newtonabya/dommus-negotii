"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { EvidenceUpload } from "@/components/evidence-upload";
import { Alert, Button, Card, Field, Input } from "@/components/ui/form";
import { activateAction, beginScanUploadAction, checkPasswordAction, finishScanUploadAction, requestCodeAction } from "./actions";

interface Props {
  token: string;
  fullName: string;
  maskedPhone: string;
  needsScan: boolean;
  consentText: string;
}

/** For members imported by Admin: accept the notice, choose a password, confirm the phone. */
export function ActivationForm(props: Props) {
  const [stage, setStage] = useState<"details" | "code" | "done">("details");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [consent, setConsent] = useState(false);
  const [scanId, setScanId] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const begin = beginScanUploadAction.bind(null, props.token);
  const finish = finishScanUploadAction.bind(null, props.token);

  async function toCode(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (password !== confirmPassword) return setError("The two passwords don't match.");
    if (!consent) return setError("You must accept the data protection notice to continue.");
    setBusy(true);
    // Check the password first: a refusal must not surface later, under the code box.
    const checked = await checkPasswordAction(props.token, password, confirmPassword);
    if (!checked.ok) {
      setBusy(false);
      return setError(checked.error);
    }
    const sent = await requestCodeAction(props.token);
    setBusy(false);
    if (!sent.ok) return setError(sent.error);
    setStage("code");
  }

  async function activate(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    const result = await activateAction(props.token, { password, confirmPassword, consent: consent as true, idScanEvidenceId: scanId, code });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setStage("done");
  }

  if (stage === "done") {
    return (
      <Card
        title="Your login is ready"
        footer={
          <Link href="/sign-in" className="underline">
            Sign in
          </Link>
        }
      >
        <Alert tone="success">Sign in with your phone number and the password you just chose.</Alert>
      </Card>
    );
  }

  if (stage === "code") {
    return (
      <Card title="Confirm your phone">
        <p className="text-sm text-muted">We sent a 6-digit code by SMS to {props.maskedPhone}. It expires in 5 minutes.</p>
        <form onSubmit={activate} className="flex flex-col gap-4">
          <Field label="Code from the SMS">
            <Input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" required autoFocus value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <div className="flex flex-wrap items-center gap-4">
            <Button type="submit" disabled={busy}>
              {busy ? "Setting up…" : "Finish"}
            </Button>
            <button type="button" className="text-sm underline" onClick={() => void requestCodeAction(props.token).then((r) => setError(r.ok ? null : r.error))}>
              Send a new code
            </button>
          </div>
        </form>
      </Card>
    );
  }

  return (
    <Card title={`Welcome, ${props.fullName.split(" ")[0]}`}>
      <p className="text-sm text-muted">
        Your MOAUM Credit Super Store membership is now on Dommus Negotii. Set up your login for the phone number{" "}
        {props.maskedPhone}; we&apos;ll text you a code to confirm it.
      </p>
      <form onSubmit={toCode} className="flex flex-col gap-4">
        {props.needsScan ? (
          <EvidenceUpload
            label="Scan or photo of your MOAUM ID card (optional, but needed before you can apply for a loan)"
            types={["jpg", "png", "pdf"]}
            begin={begin}
            finish={finish}
            onUploaded={(f) => setScanId(f.evidenceId)}
          />
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Choose a password" hint="At least 10 characters. Common passwords, and ones that have leaked in data breaches, are refused.">
            <Input type="password" required minLength={10} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label="Confirm password">
            <Input type="password" required minLength={10} autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
          </Field>
        </div>
        <label className="flex gap-3 rounded-md border border-border bg-background p-3 text-sm">
          <input type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>{props.consentText}</span>
        </label>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Button type="submit" disabled={busy}>
          {busy ? "Sending code…" : "Continue"}
        </Button>
      </form>
    </Card>
  );
}
