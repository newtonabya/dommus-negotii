"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, Button, Card, Field, Input } from "@/components/ui/form";
import { authClient } from "@/shell/auth/auth-client";

export default function TwoFactorPage() {
  const router = useRouter();
  const [useBackup, setUseBackup] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = useBackup
      ? await authClient.twoFactor.verifyBackupCode({ code: code.trim() })
      : await authClient.twoFactor.verifyTotp({ code: code.replace(/\s/g, "") });
    setBusy(false);
    if (result.error) {
      setError(result.error.message ?? "That code didn't work.");
      return;
    }
    router.replace("/");
    router.refresh();
  }

  return (
    <Card
      title="Two-factor check"
      footer={
        <button type="button" className="underline" onClick={() => setUseBackup((v) => !v)}>
          {useBackup ? "Use your authenticator app instead" : "Lost your phone? Use a backup code"}
        </button>
      }
    >
      <p className="text-sm text-muted">
        {useBackup
          ? "Enter one of the backup codes you saved when you set up two-factor login. Each code works once."
          : "Enter the 6-digit code from your authenticator app."}
      </p>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label={useBackup ? "Backup code" : "Authentication code"}>
          <Input
            name="code"
            inputMode={useBackup ? "text" : "numeric"}
            autoComplete="one-time-code"
            autoFocus
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </Field>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Button type="submit" disabled={busy}>
          {busy ? "Checking…" : "Continue"}
        </Button>
      </form>
    </Card>
  );
}
