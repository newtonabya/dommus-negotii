"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { EvidenceUpload } from "@/components/evidence-upload";
import { Alert, Button, Field, Input, Select } from "@/components/ui/form";
import { normalizeNigerianPhone } from "@/shell/auth/phone";
import { beginMemberUploadAction, finishMemberUploadAction, requestChangeAction, sendPhoneCodeAction } from "./actions";

interface Props {
  current: {
    fullName: string;
    phone: string;
    email: string;
    address: string;
    moaumIdNumber: string;
    nextOfKinName: string;
    nextOfKinPhone: string;
    remittanceSourceId: string;
  };
  sources: Array<{ id: string; name: string }>;
}

/** Ask for changes to contact or KYC details; a Loan Officer reviews them (PRD F5). */
export function ChangeForm({ current, sources }: Props) {
  const router = useRouter();
  const [values, setValues] = useState(current);
  const [scanId, setScanId] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [note, setNote] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [notice, setNotice] = useState<{ tone: "error" | "success" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (key: keyof Props["current"]) => (e: { target: { value: string } }) => setValues((v) => ({ ...v, [key]: e.target.value }));
  const phoneChanged = normalizeNigerianPhone(values.phone) !== normalizeNigerianPhone(current.phone);
  const needsDocument = values.fullName.trim() !== current.fullName || values.moaumIdNumber.trim().toUpperCase() !== current.moaumIdNumber;

  async function sendCode() {
    setBusy(true);
    const result = await sendPhoneCodeAction(values.phone);
    setBusy(false);
    if (!result.ok) return setNotice({ tone: "error", text: result.error });
    setCodeSent(true);
    setNotice({ tone: "info", text: "We texted a 6-digit code to the new number. It expires in 10 minutes." });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setNotice(null);
    setBusy(true);
    const result = await requestChangeAction({ values: { ...values, idScanEvidenceId: scanId }, note, evidenceId: documentId, phoneCode: code });
    setBusy(false);
    if (!result.ok) return setNotice({ tone: "error", text: result.error });
    setNotice({ tone: "success", text: "Request sent. A Loan Officer will review it; your details change once it is approved." });
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Full name">
          <Input value={values.fullName} onChange={set("fullName")} required minLength={3} />
        </Field>
        <Field label="MOAUM ID card number">
          <Input value={values.moaumIdNumber} onChange={set("moaumIdNumber")} required />
        </Field>
        <Field label="Phone" hint="A new number must be confirmed by SMS code.">
          <Input value={values.phone} onChange={set("phone")} required inputMode="tel" />
        </Field>
        <Field label="Email (optional)">
          <Input type="email" value={values.email} onChange={set("email")} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Home address">
            <Input value={values.address} onChange={set("address")} required minLength={10} />
          </Field>
        </div>
        <Field label="Next of kin">
          <Input value={values.nextOfKinName} onChange={set("nextOfKinName")} required minLength={3} />
        </Field>
        <Field label="Next of kin's phone">
          <Input value={values.nextOfKinPhone} onChange={set("nextOfKinPhone")} required inputMode="tel" />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Remittance source">
            <Select value={values.remittanceSourceId} onChange={set("remittanceSourceId")}>
              <option value="">None — I pay directly</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>

      {phoneChanged ? (
        <div className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-background p-3">
          <Button type="button" variant="secondary" disabled={busy} onClick={() => void sendCode()}>
            {codeSent ? "Send a new code" : "Text a code to the new number"}
          </Button>
          {codeSent ? (
            <Field label="Code from the SMS">
              <Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" pattern="\d{6}" required autoComplete="one-time-code" />
            </Field>
          ) : null}
        </div>
      ) : null}

      <EvidenceUpload
        label="New ID card scan (only if your card or scan has changed)"
        types={["jpg", "png", "pdf"]}
        begin={beginMemberUploadAction}
        finish={finishMemberUploadAction}
        onUploaded={(f) => setScanId(f.evidenceId)}
      />
      <EvidenceUpload
        label={needsDocument ? "Supporting document (required for a new name or MOAUM ID number)" : "Supporting document (optional)"}
        types={["jpg", "png", "pdf"]}
        begin={beginMemberUploadAction}
        finish={finishMemberUploadAction}
        onUploaded={(f) => setDocumentId(f.evidenceId)}
      />
      <Field label="Note for the Loan Officer (optional)">
        <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </Field>

      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
      <div>
        <Button type="submit" disabled={busy || (phoneChanged && !codeSent)}>
          {busy ? "Sending…" : "Send for review"}
        </Button>
      </div>
    </form>
  );
}
