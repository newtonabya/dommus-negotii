import type { Metadata } from "next";
import Link from "next/link";
import { Alert, Button, Card, Input } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { formatNaira, kobo } from "@/lib/money";
import { cashierQueue, MATCH_WINDOW_DAYS, openTags, unmatchedLines } from "@/modules/credit/banking/matching";
import { requireStaffPermission } from "@/shell/auth/session";
import { hasPermission } from "@/shell/rbac/permissions";
import { matchVoucherAction, returnEntryAction, tagMemberAction, verifyEntryAction, verifyLodgementAction } from "../matching-actions";

export const metadata: Metadata = { title: "Bank matching" };

const naira = (v: bigint) => formatNaira(kobo(v));
const day = (d: Date) => d.toISOString().slice(0, 10);
const FILE = "block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-accent/10 file:px-3 file:py-2 file:text-accent";
const CATEGORY = { BANK_CHARGE: "Bank charge", BANK_INTEREST: "Bank interest", INTERNAL_TRANSFER: "Transfer between MOAUM accounts" } as const;

export default async function BankMatchingPage({ searchParams }: PageProps<"/staff/bank/matching">) {
  const user = await requireStaffPermission("credit.read");
  const can = (a: Parameters<typeof hasPermission>[1]) => hasPermission(user.assignments, a);
  const { ok, error } = await searchParams;
  const db = getDb();
  const [lines, tags, queue] = await Promise.all([unmatchedLines(db), openTags(db), cashierQueue(db)]);
  const credits = lines.filter((l) => l.direction === "CREDIT");
  const debits = lines.filter((l) => l.direction === "DEBIT");
  const entries = queue.entries.filter((e) => e.status === "PREPARED");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/staff/bank" className="text-sm underline">
          ← Bank
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Matching statement lines</h1>
        <p className="text-sm text-muted">
          The system proposes lodgements and vouchers with the same amount, on the same account, within ±{MATCH_WINDOW_DAYS} days.
          Check the reference and confirm; nothing is matched automatically. A credit a member paid directly is tagged to
          that member. See also the{" "}
          <Link className="underline" href="/staff/bank/ageing">
            ageing report
          </Link>
          .
        </p>
      </div>
      {typeof ok === "string" ? <Alert tone="success">{ok}</Alert> : null}
      {typeof error === "string" ? <Alert tone="error">{error}</Alert> : null}

      {entries.length ? (
        <Card title="Entries waiting for verification">
          <ul className="text-sm">
            {entries.map((e) => (
              <li key={e.id} className="flex flex-wrap items-end justify-between gap-2 border-t border-border py-2 first:border-0">
                <span>
                  {CATEGORY[e.category]} · {e.line.direction === "CREDIT" ? "+" : "−"}
                  {naira(e.line.amount)} on {day(e.line.transactionDate)} · {e.line.narration}
                  {e.note ? <span className="text-muted"> · {e.note}</span> : null}
                </span>
                {can("bankLineEntry.verify") && e.recordedById !== user.id ? (
                  <span className="flex flex-wrap gap-2">
                    <form action={verifyEntryAction.bind(null, e.id)}>
                      <Button type="submit">Verify</Button>
                    </form>
                    <form action={returnEntryAction.bind(null, e.id)} className="flex gap-2">
                      <Input name="reason" required minLength={5} placeholder="Why" className="w-40" />
                      <Button type="submit" variant="danger">
                        Return
                      </Button>
                    </form>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card title={`Unmatched credits (${credits.length})`}>
        {credits.length === 0 ? <p className="text-sm text-muted">Every credit is matched or tagged.</p> : null}
        <ul className="flex flex-col text-sm">
          {credits.map((l) => (
            <li key={l.id} className="border-t border-border py-3 first:border-0">
              <div className="font-medium tabular-nums">
                +{naira(l.amount)} · {day(l.transactionDate)} · {l.reference || "no reference"} · {l.bankAccount.bankName} {l.bankAccount.accountNumber}
              </div>
              <div className="text-muted">{l.narration}</div>
              {can("lodgement.verify") ? (
                l.lodgements.length ? (
                  <ul className="mt-2 flex flex-col gap-1">
                    {l.lodgements.map((g) => (
                      <li key={g.id} className="flex flex-wrap items-center gap-2">
                        <form action={verifyLodgementAction.bind(null, l.id, g.id)}>
                          <Button type="submit" variant="secondary">
                            Verify
                          </Button>
                        </form>
                        Lodgement {g.reference} of {day(g.depositDate)} on schedule {g.schedule?.scheduleReference ?? "—"} ({g.schedule?.remittanceSource.code})
                        {g.sameReference ? <span className="font-semibold text-success">✓ same reference</span> : <span className="text-muted">reference differs</span>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-muted">No declared lodgement matches.</p>
                )
              ) : null}
              {can("bankCredit.tagMember") ? (
                <details className="mt-2">
                  <summary className="cursor-pointer text-accent">A member paid this directly</summary>
                  <form action={tagMemberAction.bind(null, l.id)} className="mt-2 flex flex-wrap items-end gap-2">
                    <Input name="member" required placeholder="Member no. (MCS-…) or MOAUM ID" className="w-56" />
                    <Input name="note" placeholder="Note (optional)" className="w-56" />
                    <input type="file" name="receipt" accept=".pdf,.jpg,.jpeg,.png" className={`${FILE} w-56`} aria-label="Member's transfer receipt (optional)" />
                    <Button type="submit">Tag to member</Button>
                  </form>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>

      <Card title={`Unmatched debits (${debits.length})`}>
        {debits.length === 0 ? <p className="text-sm text-muted">Every debit is matched or recorded.</p> : null}
        <ul className="flex flex-col text-sm">
          {debits.map((l) => (
            <li key={l.id} className="border-t border-border py-3 first:border-0">
              <div className="font-medium tabular-nums">
                −{naira(l.amount)} · {day(l.transactionDate)} · {l.reference || "no reference"} · {l.bankAccount.bankName} {l.bankAccount.accountNumber}
              </div>
              <div className="text-muted">{l.narration}</div>
              {can("bankDebit.match") && l.vouchers.length ? (
                <ul className="mt-2 flex flex-col gap-1">
                  {l.vouchers.map((v) => (
                    <li key={v.id} className="flex flex-wrap items-center gap-2">
                      <form action={matchVoucherAction.bind(null, l.id, v.id)}>
                        <Button type="submit" variant="secondary">
                          Match
                        </Button>
                      </form>
                      {v.type === "DISBURSEMENT" ? "Disbursement" : "Refund"} voucher {v.transferRef} of {day(v.valueDate)}
                      {v.loan?.loanAccountNo ? ` · loan ${v.loan.loanAccountNo}` : ""}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-muted">No verified voucher matches. If it is a bank charge or a transfer, the Cashier records it.</p>
              )}
            </li>
          ))}
        </ul>
      </Card>

      <Card title={`Direct payments not yet on a schedule (${tags.length})`}>
        {tags.length === 0 ? (
          <p className="text-sm text-muted">None.</p>
        ) : (
          <ul className="text-sm tabular-nums">
            {tags.map((t) => (
              <li key={t.id} className="border-t border-border py-2 first:border-0">
                <span className="font-mono">{t.reference}</span> · {t.member.fullName} ({t.member.memberNo}) · {naira(t.line.amount)} on {day(t.line.transactionDate)}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
