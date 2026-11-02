"use client";

import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { useState, type FormEvent } from "react";
import { Alert, Button, Card, Field, Input } from "@/components/ui/form";
import { authClient } from "@/shell/auth/auth-client";

interface Enrolment {
  qr: string;
  secret: string;
  backupCodes: string[];
}

export function TwoFactorSetup({ required }: { required: boolean }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await authClient.twoFactor.enable({ password });
    setBusy(false);
    if (result.error || !result.data) {
      setError(result.error?.message ?? "Could not start two-factor setup.");
      return;
    }
    const { totpURI, backupCodes } = result.data as { totpURI: string; backupCodes: string[] };
    setEnrolment({
      qr: await QRCode.toDataURL(totpURI, { margin: 1, width: 220 }),
      secret: new URL(totpURI).searchParams.get("secret") ?? "",
      backupCodes,
    });
    setPassword("");
  }

  async function confirm(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await authClient.twoFactor.verifyTotp({ code: code.replace(/\s/g, "") });
    setBusy(false);
    if (result.error) {
      setError(result.error.message ?? "That code didn't work. Check the time on your phone and try again.");
      return;
    }
    router.replace("/");
    router.refresh();
  }

  if (!enrolment) {
    return (
      <Card title="Set up two-factor login">
        <p className="text-sm text-muted">
          {required
            ? "Staff accounts must use two-factor login. You'll need an authenticator app such as Google Authenticator, Microsoft Authenticator or Authy."
            : "Add an authenticator app as a second step when you sign in."}
        </p>
        <form onSubmit={start} className="flex flex-col gap-4">
          <Field label="Confirm your password">
            <Input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <Button type="submit" disabled={busy}>
            {busy ? "Starting…" : "Continue"}
          </Button>
        </form>
      </Card>
    );
  }

  return (
    <Card title="Scan and confirm">
      <ol className="flex list-decimal flex-col gap-3 pl-5 text-sm">
        <li>
          Scan this code with your authenticator app.
          {/* eslint-disable-next-line @next/next/no-img-element -- a generated data URL, not a remote image */}
          <img src={enrolment.qr} alt="QR code for your authenticator app" className="mt-2 rounded border border-border bg-white p-1" width={220} height={220} />
          <span className="mt-2 block text-xs text-muted">
            Can&apos;t scan? Enter this key by hand:{" "}
            <code className="font-mono break-all text-foreground" data-testid="totp-secret">
              {enrolment.secret}
            </code>
          </span>
        </li>
        <li>
          Save these backup codes somewhere safe, offline. Each one lets you in once if you lose your phone.
          <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-xs" data-testid="backup-codes">
            {enrolment.backupCodes.map((c) => (
              <li key={c} className="rounded bg-background px-2 py-1">
                {c}
              </li>
            ))}
          </ul>
        </li>
        <li>Enter the 6-digit code your app now shows.</li>
      </ol>
      <form onSubmit={confirm} className="flex flex-col gap-4">
        <Field label="Authentication code">
          <Input
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </Field>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Button type="submit" disabled={busy}>
          {busy ? "Confirming…" : "Turn on two-factor login"}
        </Button>
      </form>
    </Card>
  );
}
