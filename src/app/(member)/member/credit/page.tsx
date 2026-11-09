import type { Metadata } from "next";
import Link from "next/link";
import { Alert, Button, Card, Field, Input } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { formatNaira, kobo } from "@/lib/money";
import { creditMovements, refundableCredit } from "@/modules/credit/refunds/refunds";
import { requireUser } from "@/shell/auth/session";
import { cancelRefundAction, requestRefundAction } from "./actions";

export const metadata: Metadata = { title: "Overpayment Credit" };

const naira = (v: bigint) => formatNaira(kobo(v));
const STATUS = { REQUESTED: "Waiting for Management", APPROVED: "Approved, transfer on its way", REJECTED: "Not approved", CANCELLED: "Withdrawn", PAID: "Paid" } as const;

export default async function MemberCreditPage({ searchParams }: PageProps<"/member/credit">) {
  const user = await requireUser();
  const { ok, error } = await searchParams;
  const db = getDb();
  const member = await db.member.findUnique({ where: { userId: user.id } });
  if (!member) return <p className="text-sm text-muted">No membership is linked to this login.</p>;
  const [moves, available, refunds] = await Promise.all([
    creditMovements(db, member.id),
    refundableCredit(db, member.id),
    db.refund.findMany({ where: { memberId: member.id }, orderBy: { requestedAt: "desc" } }),
  ]);
  const balance = moves.at(-1)?.balance ?? kobo(0n);
  const open = refunds.find((r) => r.status === "REQUESTED" || r.status === "APPROVED");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/member" className="text-sm underline">
          ← Home
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Overpayment Credit</h1>
        <p className="text-sm text-muted">
          Money of yours that MOAUM holds: a payment after your loan was repaid, a deduction when you had no active loan, or a
          prepayment you asked to have back. It is only ever refunded to you, never used for another loan.
        </p>
      </div>
      {typeof ok === "string" ? <Alert tone="success">{ok}</Alert> : null}
      {typeof error === "string" ? <Alert tone="error">{error}</Alert> : null}

      <Card title="Balance">
        <p className="text-2xl font-semibold tabular-nums">{naira(balance)}</p>
        {open ? <p className="mt-1 text-sm text-muted">{naira(open.amount)} of it is in a refund request ({STATUS[open.status].toLowerCase()}).</p> : null}
      </Card>

      {open ? (
        <Card title="Your refund request">
          <p className="text-sm">
            {naira(open.amount)} to {open.beneficiaryName}, {open.beneficiaryBank} {open.beneficiaryAccountNo} · <strong>{STATUS[open.status]}</strong>
          </p>
          {open.status === "REQUESTED" ? (
            <form action={cancelRefundAction.bind(null, open.id)} className="mt-3">
              <Button type="submit" variant="secondary">
                Withdraw the request
              </Button>
            </form>
          ) : null}
        </Card>
      ) : available > 0n ? (
        <Card title="Ask for a refund">
          <form action={requestRefundAction} className="grid gap-4 sm:grid-cols-2">
            <Field label="Amount (₦)" hint={`Up to ${naira(available)}`}>
              <Input name="amount" required inputMode="decimal" defaultValue={`${available / 100n}.${String(available % 100n).padStart(2, "0")}`} />
            </Field>
            <Field label="Account holder's name">
              <Input name="beneficiaryName" required minLength={3} defaultValue={member.fullName} />
            </Field>
            <Field label="Bank">
              <Input name="beneficiaryBank" required minLength={2} placeholder="e.g. First Bank" />
            </Field>
            <Field label="Account number" hint="10 digits">
              <Input name="beneficiaryAccountNo" required inputMode="numeric" pattern="\d{10}" />
            </Field>
            <Field label="Note (optional)">
              <Input name="note" maxLength={300} />
            </Field>
            <div className="sm:col-span-2">
              <Button type="submit">Request the refund</Button>
            </div>
          </form>
        </Card>
      ) : null}

      <Card title="History">
        {moves.length === 0 ? (
          <p className="text-sm text-muted">Nothing yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-left text-sm tabular-nums">
              <thead className="text-xs text-muted uppercase">
                <tr>
                  <th className="py-1 pr-3">Date</th>
                  <th className="py-1 pr-3">What</th>
                  <th className="py-1 pr-3 text-right">Amount</th>
                  <th className="py-1 text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {moves.map((m) => (
                  <tr key={m.id} className="border-t border-border">
                    <td className="py-1 pr-3">{m.date}</td>
                    <td className="py-1 pr-3">{m.what}</td>
                    <td className={`py-1 pr-3 text-right ${m.change < 0n ? "text-danger" : ""}`}>{naira(m.change)}</td>
                    <td className="py-1 text-right">{naira(m.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {refunds.some((r) => r.status === "REJECTED") ? (
          <ul className="mt-3 text-sm text-muted">
            {refunds
              .filter((r) => r.status === "REJECTED")
              .map((r) => (
                <li key={r.id}>
                  Request of {naira(r.amount)} not approved: {r.decisionComment}
                </li>
              ))}
          </ul>
        ) : null}
      </Card>
    </div>
  );
}
