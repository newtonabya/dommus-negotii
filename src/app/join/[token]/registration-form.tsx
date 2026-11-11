"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { EvidenceUpload } from "@/components/evidence-upload";
import { Alert, Button, Card, Field, Input, Select } from "@/components/ui/form";
import { beginScanUploadAction, checkDetailsAction, finishScanUploadAction, registerAction, requestCodeAction } from "./actions";

interface Props {
  token: string;
  fullName: string;
  maskedPhone: string;
  email: string;
  defaultSourceId: string;
  sources: { id: string; name: string }[];
  consentText: string;
}

type Stage = "details" | "code" | "done";

export function RegistrationForm(props: Props) {
  const [stage, setStage] = useState<Stage>("details");
  const [values, setValues] = useState({
    fullName: props.fullName,
    email: props.email,
    address: "",
    moaumIdNumber: "",
    nextOfKinName: "",
    nextOfKinPhone: "",
    remittanceSourceId: props.defaultSourceId || "",
    password: "",
    confirmPassword: "",
  });
  const [scan, setScan] = useState<{ evidenceId: string; filename: string } | null>(null);
  const [consent, setConsent] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (key: keyof typeof values) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  // Bound to this link, so the upload steps work without a login.
  const begin = beginScanUploadAction.bind(null, props.token);
  const finish = finishScanUploadAction.bind(null, props.token);

  async function toCode(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!scan) return setError("Upload a scan or photo of your MOAUM ID card.");
    if (values.password !== values.confirmPassword) return setError("The two passwords don't match.");
    if (!values.remittanceSourceId) return setError("Choose how your repayments reach MOAUM.");
    if (!consent) return setError("You must accept the data protection notice to register.");
    setBusy(true);
    // Check the details first: a mistake here must not surface later, under the code box.
    const checked = await checkDetailsAction(props.token, { ...values, idScanEvidenceId: scan.evidenceId, consent: true });
    if (!checked.ok) {
      setBusy(false);
      return setError(checked.error);
    }
    const sent = await requestCodeAction(props.token);
    setBusy(false);
    if (!sent.ok) return setError(sent.error);
    setStage("code");
  }

  async function register(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    const result = await registerAction(props.token, {
      ...values,
      idScanEvidenceId: scan?.evidenceId ?? "",
      consent: consent as true,
      code,
    });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setStage("done");
  }

  async function resendCode() {
    setError(null);
    const sent = await requestCodeAction(props.token);
    setError(sent.ok ? null : sent.error);
  }

  if (stage === "done") {
    return (
      <Card
        title="Registration received"
        footer={
          <Link href="/sign-in" className="underline">
            Sign in to check your status
          </Link>
        }
      >
        <Alert tone="success">
          Thank you. A Loan Officer will review your registration, and we&apos;ll text you when it&apos;s done. You can sign
          in with your phone number and the password you chose.
        </Alert>
      </Card>
    );
  }

  if (stage === "code") {
    return (
      <Card title="Confirm your phone">
        <p className="text-sm text-muted">We sent a 6-digit code by SMS to {props.maskedPhone}. It expires in 5 minutes.</p>
        <form onSubmit={register} className="flex flex-col gap-4">
          <Field label="Code from the SMS">
            <Input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" required autoFocus value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <div className="flex flex-wrap items-center gap-4">
            <Button type="submit" disabled={busy}>
              {busy ? "Registering…" : "Complete registration"}
            </Button>
            <button type="button" className="text-sm underline" onClick={resendCode}>
              Send a new code
            </button>
            <button type="button" className="text-sm underline" onClick={() => setStage("details")}>
              Back to my details
            </button>
          </div>
        </form>
      </Card>
    );
  }

  return (
    <Card title="Register as a member">
      <p className="text-sm text-muted">
        Your invitation is for the phone number {props.maskedPhone}. We&apos;ll text a code to it before you finish.
      </p>
      <form onSubmit={toCode} className="flex flex-col gap-4">
        <Field label="Full name (as on your ID card)">
          <Input required minLength={3} autoComplete="name" value={values.fullName} onChange={set("fullName")} />
        </Field>
        <Field label="Email (optional)">
          <Input type="email" autoComplete="email" value={values.email} onChange={set("email")} />
        </Field>
        <Field label="Home address">
          <Input required minLength={10} autoComplete="street-address" value={values.address} onChange={set("address")} />
        </Field>
        <Field label="MOAUM ID card number">
          <Input required autoComplete="off" value={values.moaumIdNumber} onChange={set("moaumIdNumber")} />
        </Field>
        <EvidenceUpload
          label="Scan or photo of your MOAUM ID card"
          types={["jpg", "png", "pdf"]}
          begin={begin}
          finish={finish}
          onUploaded={(f) => setScan({ evidenceId: f.evidenceId, filename: f.filename })}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Next of kin: full name">
            <Input required minLength={3} value={values.nextOfKinName} onChange={set("nextOfKinName")} />
          </Field>
          <Field label="Next of kin: phone" hint="A Nigerian mobile number, 11 digits, e.g. 0803 123 4567.">
            <Input required inputMode="tel" value={values.nextOfKinPhone} onChange={set("nextOfKinPhone")} />
          </Field>
        </div>
        <Field label="How do your repayments reach MOAUM?">
          <Select required value={values.remittanceSourceId} onChange={set("remittanceSourceId")}>
            <option value="" disabled>
              Choose…
            </option>
            {props.sources.map((s) => (
              <option key={s.id} value={s.id}>
                Deducted by {s.name}
              </option>
            ))}
            <option value="NONE">None — I pay directly into MOAUM&apos;s bank account</option>
          </Select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Choose a password" hint="At least 10 characters. Common passwords, and ones that have leaked in data breaches, are refused.">
            <Input type="password" required minLength={10} autoComplete="new-password" value={values.password} onChange={set("password")} />
          </Field>
          <Field label="Confirm password">
            <Input type="password" required minLength={10} autoComplete="new-password" value={values.confirmPassword} onChange={set("confirmPassword")} />
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
