"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Alert, Button, Card, Field, Input } from "@/components/ui/form";
import { setPasswordFromLinkAction } from "./actions";

interface Props {
  token: string;
  firstName: string;
  memberNo: string;
  maskedPhone: string;
  /** Shown when the member hasn't accepted the data protection notice yet. */
  consentText: string | null;
}

export function SetPasswordForm(props: Props) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (password !== confirmPassword) return setError("The two passwords don't match.");
    if (props.consentText && !consent) return setError("You must accept the data protection notice to continue.");
    setBusy(true);
    const result = await setPasswordFromLinkAction(props.token, { password, confirmPassword, consent });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setDone(true);
  }

  if (done) {
    return (
      <Card
        title="Your password is set"
        footer={
          <Link href="/sign-in" className="underline">
            Sign in
          </Link>
        }
      >
        <Alert tone="success">Choose Member on the sign-in page, then use your phone number ({props.maskedPhone}) and the password you just chose.</Alert>
      </Card>
    );
  }

  return (
    <Card title={`Welcome, ${props.firstName}`}>
      <p className="text-sm text-muted">
        Choose a password for your MOAUM Credit Super Store login. Your phone number {props.maskedPhone} is your username, and your MOAUM number is{" "}
        <span className="font-mono">{props.memberNo}</span>. This link works once.
      </p>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label="Choose a password" hint="At least 10 characters. Passwords that have leaked in data breaches are refused.">
          <Input type="password" required minLength={10} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Confirm password">
          <Input type="password" required minLength={10} autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
        </Field>
        {props.consentText ? (
          <label className="flex gap-3 rounded-md border border-border bg-background p-3 text-sm">
            <input type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>{props.consentText}</span>
          </label>
        ) : null}
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Set password"}
        </Button>
      </form>
    </Card>
  );
}
