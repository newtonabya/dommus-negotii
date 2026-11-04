"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { EvidenceUpload } from "@/components/evidence-upload";
import { Alert, Button, Field, Input, Select } from "@/components/ui/form";
import { prepareVoucherAction } from "./actions";

interface Props {
  loanId: string;
  amount: string;
  today: string;
  member: string;
  accounts: Array<{ id: string; label: string }>;
}

/** Cashier: record the transfer already made, with its evidence (PRD F7). */
export function VoucherForm({ loanId, amount, today, member, accounts }: Props) {
  const router = useRouter();
  const [values, setValues] = useState({ bankAccountId: accounts[0]?.id ?? "", valueDate: today, transferRef: "", beneficiaryName: member, beneficiaryBank: "", beneficiaryAccountNo: "" });
  const [evidenceId, setEvidenceId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof values) => (e: { target: { value: string } }) => setValues((v) => ({ ...v, [k]: e.target.value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!evidenceId) return setError("Upload the transfer evidence first.");
    setBusy(true);
    const result = await prepareVoucherAction(loanId, { ...values, evidenceId });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    router.refresh();
  }

  if (accounts.length === 0) return <Alert tone="error">No MOAUM bank account is set up. Ask the Admin to add one under Bank accounts.</Alert>;
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <p className="text-sm">
        Amount: <strong className="tabular-nums">{amount}</strong> <span className="text-muted">(the full approved amount; no deductions)</span>
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Paid from (MOAUM account)">
          <Select value={values.bankAccountId} onChange={set("bankAccountId")}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Value date of the transfer" hint="Becomes the loan's disbursement date">
          <Input type="date" value={values.valueDate} max={today} onChange={set("valueDate")} required />
        </Field>
        <Field label="Transfer reference">
          <Input value={values.transferRef} onChange={set("transferRef")} required minLength={2} />
        </Field>
        <Field label="Beneficiary name">
          <Input value={values.beneficiaryName} onChange={set("beneficiaryName")} required />
        </Field>
        <Field label="Beneficiary bank">
          <Input value={values.beneficiaryBank} onChange={set("beneficiaryBank")} required />
        </Field>
        <Field label="Beneficiary account number" hint="10 digits (NUBAN)">
          <Input value={values.beneficiaryAccountNo} onChange={set("beneficiaryAccountNo")} required inputMode="numeric" pattern="\d{10}" />
        </Field>
      </div>
      <EvidenceUpload label="Transfer evidence (bank confirmation or debit advice)" types={["pdf", "jpg", "png"]} onUploaded={(f) => setEvidenceId(f.evidenceId)} />
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? "Sending…" : "Send voucher for verification"}
        </Button>
      </div>
    </form>
  );
}
