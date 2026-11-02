"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, Button, Card, Field, Input } from "@/components/ui/form";
import { authClient } from "@/shell/auth/auth-client";

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (password !== confirm) {
      setError("The two passwords don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await authClient.resetPassword({ newPassword: password, token });
    setBusy(false);
    if (result.error) setError(result.error.message ?? "Could not set the password.");
    else router.replace("/sign-in?reason=password-set");
  }

  return (
    <Card title="Set your password">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label="New password" hint="At least 10 characters. Passwords found in known data breaches are refused.">
          <Input type="password" autoComplete="new-password" minLength={10} required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Confirm password">
          <Input type="password" autoComplete="new-password" minLength={10} required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Set password"}
        </Button>
      </form>
    </Card>
  );
}
