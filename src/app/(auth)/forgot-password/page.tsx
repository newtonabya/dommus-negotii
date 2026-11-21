"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, Button, Card, Field, Input } from "@/components/ui/form";
import { authClient } from "@/shell/auth/auth-client";
import { normalizeNigerianPhone } from "@/shell/auth/phone";
import { CodeChannelSwitch } from "@/components/code-channel-switch";
import { resendCodeAction } from "../code-actions";
import { resetByPhoneAction } from "./actions";

export default function ForgotPasswordPage() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState("");
  const [stage, setStage] = useState<"ask" | "email-sent" | "phone-email-sent" | "phone-code">("ask");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function request(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (identifier.includes("@")) {
        await authClient.requestPasswordReset({ email: identifier.trim(), redirectTo: "/reset-password" });
        setStage("email-sent");
        return;
      }
      const phoneNumber = normalizeNigerianPhone(identifier);
      if (!phoneNumber) {
        setError("Enter your email, or a Nigerian mobile number such as 0803 123 4567.");
        return;
      }
      // While SMS is switched off, the reset link goes to the account's email instead.
      const route = await resetByPhoneAction(identifier);
      if (!route.ok) return setError(route.error);
      if (route.via === "email") return setStage("phone-email-sent");
      const result = await authClient.phoneNumber.requestPasswordReset({ phoneNumber });
      if (result.error) setError(result.error.message ?? "Could not send a code.");
      else setStage("phone-code");
    } finally {
      setBusy(false);
    }
  }

  async function resetByPhone(event: FormEvent) {
    event.preventDefault();
    const phoneNumber = normalizeNigerianPhone(identifier);
    if (!phoneNumber) return;
    setBusy(true);
    setError(null);
    const result = await authClient.phoneNumber.resetPassword({ phoneNumber, otp: code.trim(), newPassword });
    setBusy(false);
    if (result.error) setError(result.error.message ?? "Could not reset the password.");
    else router.replace("/sign-in?reason=password-set");
  }

  const footer = (
    <Link href="/sign-in" className="underline">
      Back to sign in
    </Link>
  );

  if (stage === "email-sent") {
    return (
      <Card title="Check your email" footer={footer}>
        <Alert>If an account uses that email, we&apos;ve sent a link to reset the password. It expires in 1 hour.</Alert>
      </Card>
    );
  }

  if (stage === "phone-email-sent") {
    return (
      <Card title="Check your email" footer={footer}>
        <Alert>
          Text messages are switched off for now. If that number has an account with an email address, we&apos;ve emailed a link to reset the
          password. It expires in 1 hour.
        </Alert>
        <p className="text-sm text-muted">No email on your account? Ask a MOAUM Loan Officer for a sign-in link; bring your MOAUM ID card.</p>
      </Card>
    );
  }

  if (stage === "phone-code") {
    return (
      <Card title="Reset your password" footer={footer}>
        <p className="text-sm text-muted">
          If that number has an account, we sent a 6-digit code: by SMS, or by email if that&apos;s your choice under My details.
        </p>
        <form onSubmit={resetByPhone} className="flex flex-col gap-4">
          <Field label="Code">
            <Input inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
          <Field label="New password" hint="At least 10 characters.">
            <Input
              type="password"
              autoComplete="new-password"
              minLength={10}
              required
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </Field>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Set new password"}
          </Button>
          {/* This screen only appears while SMS is on; with it off, the reset link goes by email instead. */}
          <CodeChannelSwitch sms send={(channel) => resendCodeAction("reset", identifier, channel)} />
        </form>
      </Card>
    );
  }

  return (
    <Card title="Forgot your password?" footer={footer}>
      <p className="text-sm text-muted">Staff: enter your email. Members: enter your phone number or email.</p>
      <form onSubmit={request} className="flex flex-col gap-4">
        <Field label="Email or phone number">
          <Input autoComplete="username" required value={identifier} onChange={(e) => setIdentifier(e.target.value)} />
        </Field>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Button type="submit" disabled={busy}>
          {busy ? "Sending…" : "Send reset instructions"}
        </Button>
      </form>
    </Card>
  );
}
