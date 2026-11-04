"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { EvidenceUpload, type UploadedEvidence } from "@/components/evidence-upload";
import { Alert, Button, Field, Input, Select } from "@/components/ui/form";
import { localDate } from "@/lib/dates";
import { bps, formatNaira, parseNaira } from "@/lib/money";
import { planSchedule } from "@/modules/credit/domain/schedule";

type Result<T> = { ok: true; value: T } | { ok: false; error: string };
type Begin = (input: { filename: string; size: number }) => Promise<Result<{ uploadId: string; url: string; headers: Record<string, string> }>>;
type Finish = (uploadId: string) => Promise<Result<UploadedEvidence>>;

export interface ApplicationValues {
  amount: string;
  tenure: number;
  purpose: string;
  guarantorIsMember: boolean;
  guarantorMoaumId: string;
  guarantorName: string;
  guarantorPhone: string;
  guarantorAddress: string;
  guarantorRelationship: string;
  guarantorFormEvidenceId: string;
}

interface Props {
  /** Rate in force today, in basis points (for the indicative schedule). */
  rateBps: string;
  today: string;
  initial?: Partial<ApplicationValues>;
  /** Assisted capture: the Loan Officer also names the member and uploads the signed application. */
  assisted?: boolean;
  begin?: Begin;
  finish?: Finish;
  /** Returns a message, and where to go next when the save created or submitted a loan. */
  onSave: (values: ApplicationValues & { memberMoaumId: string; applicationFormEvidenceId: string }, submit: boolean) => Promise<Result<{ message: string; href?: string }>>;
  allowDraft?: boolean;
}

/** Loan application (PRD F7): amount, tenure, purpose and one guarantor, with an indicative schedule. */
export function ApplicationForm({ rateBps, today, initial, assisted, begin, finish, onSave, allowDraft }: Props) {
  const router = useRouter();
  const [v, setV] = useState<ApplicationValues>({
    amount: "",
    tenure: 6,
    purpose: "",
    guarantorIsMember: false,
    guarantorMoaumId: "",
    guarantorName: "",
    guarantorPhone: "",
    guarantorAddress: "",
    guarantorRelationship: "",
    guarantorFormEvidenceId: "",
    ...initial,
  });
  const [memberMoaumId, setMemberMoaumId] = useState("");
  const [applicationFormEvidenceId, setApplicationForm] = useState("");
  const [notice, setNotice] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof ApplicationValues) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [k]: k === "tenure" ? Number(e.target.value) : e.target.value }));

  const plan = useMemo(() => {
    try {
      const principal = parseNaira(v.amount.trim());
      if (principal <= 0n) return null;
      return planSchedule({ principal, tenure: v.tenure, rate: bps(BigInt(rateBps)), d0: localDate(today) });
    } catch {
      return null;
    }
  }, [v.amount, v.tenure, rateBps, today]);

  async function save(submit: boolean, event?: FormEvent) {
    event?.preventDefault();
    setNotice(null);
    setBusy(true);
    const result = await onSave({ ...v, memberMoaumId, applicationFormEvidenceId }, submit);
    setBusy(false);
    if (!result.ok) return setNotice({ tone: "error", text: result.error });
    setNotice({ tone: "success", text: result.value.message });
    if (result.value.href) router.push(result.value.href);
  }

  return (
    <form onSubmit={(e) => void save(true, e)} className="flex flex-col gap-5">
      {assisted ? (
        <Field label="Member's MOAUM ID number">
          <Input value={memberMoaumId} onChange={(e) => setMemberMoaumId(e.target.value)} required />
        </Field>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Amount (₦)" hint="e.g. 150,000">
          <Input value={v.amount} onChange={set("amount")} required inputMode="decimal" />
        </Field>
        <Field label="Repay over">
          <Select value={String(v.tenure)} onChange={set("tenure")}>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <option key={m} value={m}>
                {m} month{m === 1 ? "" : "s"}
              </option>
            ))}
          </Select>
        </Field>
        <div className="sm:col-span-2">
          <Field label="What is the loan for?">
            <Input value={v.purpose} onChange={set("purpose")} required minLength={5} maxLength={300} />
          </Field>
        </div>
      </div>

      {plan ? (
        <div className="rounded-lg border border-border bg-background p-4 text-sm tabular-nums">
          <div className="font-semibold">Indicative cost</div>
          <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-6 gap-y-1">
            <dt className="text-muted">First instalment</dt>
            <dd className="text-right">{formatNaira(plan.installments[0]!.amount)}</dd>
            <dt className="text-muted">Total interest</dt>
            <dd className="text-right">{formatNaira(plan.totalInterest)}</dd>
            <dt className="text-muted">Fees</dt>
            <dd className="text-right">₦0.00</dd>
            <dt className="border-t border-border pt-1 font-semibold">Total to repay</dt>
            <dd className="border-t border-border pt-1 text-right font-semibold">{formatNaira(plan.total)}</dd>
          </dl>
          <p className="mt-2 text-xs text-muted">
            Indicative only: monthly interest on the reducing balance, paid on time from today. The approved amount, tenure and rate are fixed at approval, and the binding schedule starts on the day the money is paid out.
          </p>
        </div>
      ) : null}

      <fieldset className="flex flex-col gap-4 rounded-lg border border-border p-4">
        <legend className="px-1 text-sm font-semibold">Guarantor (one)</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" checked={v.guarantorIsMember} onChange={() => setV((x) => ({ ...x, guarantorIsMember: true }))} /> A MOAUM member
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={!v.guarantorIsMember} onChange={() => setV((x) => ({ ...x, guarantorIsMember: false }))} /> Not a member
          </label>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {v.guarantorIsMember ? (
            <Field label="Guarantor's MOAUM ID number" hint="Their name and phone come from their membership">
              <Input value={v.guarantorMoaumId} onChange={set("guarantorMoaumId")} required />
            </Field>
          ) : (
            <>
              <Field label="Full name">
                <Input value={v.guarantorName} onChange={set("guarantorName")} required minLength={3} />
              </Field>
              <Field label="Phone">
                <Input value={v.guarantorPhone} onChange={set("guarantorPhone")} required inputMode="tel" />
              </Field>
            </>
          )}
          <Field label="Relationship" hint="e.g. colleague, brother">
            <Input value={v.guarantorRelationship} onChange={set("guarantorRelationship")} required minLength={3} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Guarantor's address">
              <Input value={v.guarantorAddress} onChange={set("guarantorAddress")} required minLength={10} />
            </Field>
          </div>
        </div>
        <EvidenceUpload
          label="Guarantor form, signed by the guarantor"
          types={["pdf", "jpg", "png"]}
          begin={begin}
          finish={finish}
          onUploaded={(f) => setV((x) => ({ ...x, guarantorFormEvidenceId: f.evidenceId }))}
        />
      </fieldset>

      {assisted ? (
        <EvidenceUpload label="Signed paper application form" types={["pdf", "jpg", "png"]} begin={begin} finish={finish} onUploaded={(f) => setApplicationForm(f.evidenceId)} />
      ) : null}

      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? "Sending…" : "Submit application"}
        </Button>
        {allowDraft ? (
          <Button type="button" variant="secondary" disabled={busy} onClick={() => void save(false)}>
            Save as draft
          </Button>
        ) : null}
      </div>
    </form>
  );
}
