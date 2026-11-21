"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { EvidenceUpload } from "@/components/evidence-upload";
import { CodeChannelSwitch } from "@/components/code-channel-switch";
import { Alert, Button, Card, Field, Input } from "@/components/ui/form";
import { activateAction, beginScanUploadAction, checkPasswordAction, finishScanUploadAction, requestCodeAction, type CodeSent } from "./actions";

interface Props {
  token: string;
  fullName: string;
  maskedPhone: string;
  needsScan: boolean;
  /** The record has no address or next of kin yet (created from MOAUM's loan list). */
  needsDetails: boolean;
  memberNo: string;
  consentText: string;
}

/** For members imported by Admin: accept the notice, choose a password, confirm the phone. */
export function ActivationForm(props: Props) {
  const [stage, setStage] = useState<"details" | "code" | "done">("details");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [consent, setConsent] = useState(false);
  const [scanId, setScanId] = useState("");
  const [address, setAddress] = useState("");
  const [kinName, setKinName] = useState("");
  const [kinPhone, setKinPhone] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState<CodeSent | null>(null);
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
    const result = await requestCodeAction(props.token);
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setSent(result.value);
    setStage("code");
  }

  async function resendCode(channel: "SMS" | "EMAIL") {
    const result = await requestCodeAction(props.token, channel);
    if (!result.ok) return result;
    setSent(result.value);
    return { ok: true as const, message: `A new code is on its way to ${result.value.sentTo}.` };
  }

  async function activate(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    const result = await activateAction(props.token, { password, confirmPassword, consent: consent as true, idScanEvidenceId: scanId, address, nextOfKinName: kinName, nextOfKinPhone: kinPhone, code });
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
        <p className="text-sm text-muted">We sent a 6-digit code to {sent?.sentTo ?? props.maskedPhone}. It expires in 5 minutes.</p>
        <form onSubmit={activate} className="flex flex-col gap-4">
          <Field label="The 6-digit code">
            <Input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" required autoFocus value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <div className="flex flex-wrap items-center gap-4">
            <Button type="submit" disabled={busy}>
              {busy ? "Setting up…" : "Finish"}
            </Button>
          </div>
          <CodeChannelSwitch sms={sent?.choices.sms ?? true} email={sent?.choices.email ?? false} current={sent?.channel} send={resendCode} />
        </form>
      </Card>
    );
  }

  return (
    <Card title={`Welcome, ${props.fullName.split(" ")[0]}`}>
      <p className="text-sm text-muted">
        Your MOAUM Credit Super Store membership is now on Dommus Negotii. Set up your login for the phone number{" "}
        {props.maskedPhone}; we&apos;ll send you a code to confirm it. Your MOAUM number is <span className="font-mono">{props.memberNo}</span>, and
        your phone number is your username.
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
        {props.needsDetails ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Field label="Home address" hint="You can add these later under My details, but they are needed before you can apply for a loan.">
                <Input id="activation-address" autoComplete="street-address" value={address} onChange={(e) => setAddress(e.target.value)} />
              </Field>
            </div>
            <Field label="Next of kin: full name">
              <Input id="activation-kin-name" value={kinName} onChange={(e) => setKinName(e.target.value)} />
            </Field>
            <Field label="Next of kin: phone" hint="A Nigerian mobile number, e.g. 0803 123 4567.">
              <Input id="activation-kin-phone" inputMode="tel" value={kinPhone} onChange={(e) => setKinPhone(e.target.value)} />
            </Field>
          </div>
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
