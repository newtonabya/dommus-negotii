"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, Button, Card, Field, Input } from "@/components/ui/form";
import { authClient } from "@/shell/auth/auth-client";
import { normalizeNigerianPhone } from "@/shell/auth/phone";

type Mode = "staff" | "member";

export function SignInForm({ notice }: { notice?: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("staff");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needsPhoneCode, setNeedsPhoneCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signIn() {
    const isPhone = mode === "member" && !identifier.includes("@");
    if (isPhone) {
      const phoneNumber = normalizeNigerianPhone(identifier);
      if (!phoneNumber) return setError("Enter a Nigerian mobile number, e.g. 0803 123 4567.");
      const result = await authClient.signIn.phoneNumber({ phoneNumber, password });
      if (result.error?.code === "PHONE_NUMBER_NOT_VERIFIED") {
        setNeedsPhoneCode(true);
        return setError(null);
      }
      return result.error ? setError(result.error.message ?? "Sign-in failed.") : finish(result.data);
    }
    const result = await authClient.signIn.email({ email: identifier.trim(), password });
    return result.error ? setError(result.error.message ?? "Sign-in failed.") : finish(result.data);
  }

  function finish(data: unknown) {
    // When two-factor is on, the client plugin redirects to /two-factor itself.
    if (data && typeof data === "object" && "twoFactorRedirect" in data) return;
    router.replace("/");
    router.refresh();
  }

  async function verifyPhone() {
    const phoneNumber = normalizeNigerianPhone(identifier);
    if (!phoneNumber) return;
    const result = await authClient.phoneNumber.verify({ phoneNumber, code: code.trim(), disableSession: true });
    if (result.error) return setError(result.error.message ?? "That code didn't work.");
    setNeedsPhoneCode(false);
    await signIn();
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await (needsPhoneCode ? verifyPhone() : signIn());
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Sign in"
      footer={
        <Link href="/forgot-password" className="underline">
          Forgot your password?
        </Link>
      }
    >
      {notice ? <Alert>{notice}</Alert> : null}
      <div className="grid grid-cols-2 gap-1 rounded-md border border-border p-1 text-sm" role="tablist">
        {(["staff", "member"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => {
              setMode(m);
              setError(null);
              setNeedsPhoneCode(false);
            }}
            className={`rounded px-3 py-1.5 ${mode === m ? "bg-accent text-accent-foreground" : "text-muted"}`}
          >
            {m === "staff" ? "Staff" : "Member"}
          </button>
        ))}
      </div>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label={mode === "staff" ? "Email" : "Phone number or email"}>
          <Input
            name="identifier"
            type={mode === "staff" ? "email" : "text"}
            autoComplete="username"
            required
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder={mode === "staff" ? "you@moaum.ng" : "0803 123 4567"}
          />
        </Field>
        <Field label="Password">
          <Input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {needsPhoneCode ? (
          <Field label="Code sent to your phone" hint="We sent a 6-digit code by SMS to confirm this number.">
            <Input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
        ) : null}
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Button type="submit" disabled={busy}>
          {busy ? "Signing in…" : needsPhoneCode ? "Confirm and sign in" : "Sign in"}
        </Button>
      </form>
    </Card>
  );
}
