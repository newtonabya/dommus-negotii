import type { Metadata } from "next";
import Link from "next/link";
import { Alert, Button, Card, Input, Select } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { formatNaira, kobo } from "@/lib/money";
import { cashierQueue, unmatchedLines } from "@/modules/credit/banking/matching";
import { requireStaffPermission } from "@/shell/auth/session";
import { hasPermission } from "@/shell/rbac/permissions";
import { recordEntryAction, recordLodgementAction } from "../matching-actions";

export const metadata: Metadata = { title: "Cashier: bank" };

const naira = (v: bigint) => formatNaira(kobo(v));
const day = (d: Date) => d.toISOString().slice(0, 10);

export default async function CashierBankPage({ searchParams }: PageProps<"/staff/bank/cashier">) {
  const user = await requireStaffPermission("credit.read");
  const can = (a: Parameters<typeof hasPermission>[1]) => hasPermission(user.assignments, a);
  const { ok, error } = await searchParams;
  const db = getDb();
  const [queue, lines] = await Promise.all([cashierQueue(db), unmatchedLines(db)]);
  const recordable = lines.filter((l) => (l.direction === "DEBIT" ? l.vouchers.length === 0 : l.lodgements.length === 0));
  const returned = queue.entries.filter((e) => e.status === "RETURNED" && e.recordedById === user.id);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/staff/bank" className="text-sm underline">
          ← Bank
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Cashier: record from the bank</h1>
        <p className="text-sm text-muted">
          Only lodgements the Finance Manager has verified against the bank statement can be recorded. There is no way to
          create a lodgement or a receipt from nothing.
        </p>
      </div>
      {typeof ok === "string" ? <Alert tone="success">{ok}</Alert> : null}
      {typeof error === "string" ? <Alert tone="error">{error}</Alert> : null}

      <Card title={`Verified lodgements to record (${queue.lodgements.length})`}>
        {queue.lodgements.length === 0 ? <p className="text-sm text-muted">Nothing waiting.</p> : null}
        <ul className="text-sm tabular-nums">
          {queue.lodgements.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-border py-2 first:border-0">
              <span>
                {naira(l.amount)} · {day(l.depositDate)} · {l.reference} · schedule {l.schedule?.scheduleReference ?? "—"} · {l.bankAccount.bankName} {l.bankAccount.accountNumber}
              </span>
              {can("lodgement.record") ? (
                <form action={recordLodgementAction.bind(null, l.id)}>
                  <Button type="submit">Record and apply</Button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>

      {returned.length ? (
        <Card title="Your entries returned by the Finance Manager">
          <ul className="text-sm">
            {returned.map((e) => (
              <li key={e.id} className="border-t border-border py-2 first:border-0">
                {naira(e.line.amount)} on {day(e.line.transactionDate)} · {e.line.narration} · <span className="text-danger">{e.returnReason}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {can("bankLineEntry.record") ? (
        <Card title="Bank charges, interest and transfers">
          <p className="mb-2 text-sm text-muted">Statement lines with nothing to match them. Record what each is; the Finance Manager verifies it.</p>
          {recordable.length === 0 ? <p className="text-sm text-muted">Nothing to record.</p> : null}
          <ul className="text-sm">
            {recordable.map((l) => (
              <li key={l.id} className="border-t border-border py-2 first:border-0">
                <div className="tabular-nums">
                  {l.direction === "CREDIT" ? "+" : "−"}
                  {naira(l.amount)} · {day(l.transactionDate)} · {l.narration} · {l.bankAccount.accountNumber}
                </div>
                <form action={recordEntryAction.bind(null, l.id)} className="mt-1 flex flex-wrap gap-2">
                  <Select name="category" required defaultValue={l.direction === "DEBIT" ? "BANK_CHARGE" : "BANK_INTEREST"} className="w-60">
                    {l.direction === "DEBIT" ? <option value="BANK_CHARGE">Bank charge</option> : <option value="BANK_INTEREST">Bank interest</option>}
                    <option value="INTERNAL_TRANSFER">Transfer between MOAUM accounts</option>
                  </Select>
                  <Input name="note" placeholder="Note (optional)" className="w-56" />
                  <Button type="submit" variant="secondary">
                    Record
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
