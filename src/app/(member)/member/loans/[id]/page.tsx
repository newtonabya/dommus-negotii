import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LoanStatusBadge } from "@/components/loans/status-badge";
import { Alert, Button, Card, Input } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { todayInLagos } from "@/lib/dates";
import { bps, formatNaira, kobo } from "@/lib/money";
import { STATUS_LABEL } from "@/modules/credit/domain/loan-status";
import { planSchedule } from "@/modules/credit/domain/schedule";
import { requireUser } from "@/shell/auth/session";
import { formatPercent } from "@/shell/settings/definitions";
import { getRateSetting } from "@/shell/settings/settings";
import { cancelApplicationAction } from "../actions";

export const metadata: Metadata = { title: "Loan" };

const naira = (v: bigint | string) => formatNaira(kobo(BigInt(v)));
const when = (d: Date) => d.toLocaleString("en-NG", { timeZone: "Africa/Lagos", dateStyle: "medium" });

/** The steps a member sees, in order. */
const STEPS = ["SUBMITTED", "VERIFIED", "RECOMMENDED", "APPROVED", "ACTIVE"] as const;

interface Row {
  k: number;
  dueDate: string;
  principal: string;
  interest: string;
  amount: string;
}

export default async function MyLoanPage({ params, searchParams }: PageProps<"/member/loans/[id]">) {
  const user = await requireUser();
  const { id } = await params;
  const { ok, error } = await searchParams;
  const db = getDb();
  const loan = await db.loan.findUnique({
    where: { id },
    include: { member: { select: { userId: true } }, guarantor: true, transitions: { orderBy: { at: "asc" } } },
  });
  if (!loan || loan.member.userId !== user.id) notFound();
  const today = todayInLagos();
  const rate = loan.rateBps !== null ? bps(BigInt(loan.rateBps)) : await getRateSetting(db, "interest_rate_bps", today);
  const binding = loan.bindingSchedule as { installments: Row[]; total: string; totalInterest: string } | null;
  const plan = planSchedule({
    principal: kobo(loan.amountApproved ?? loan.amountRequested),
    tenure: loan.tenureApproved ?? loan.tenureRequested,
    rate,
    d0: today,
  });
  const rows: Row[] =
    binding?.installments ??
    plan.installments.map((i) => ({ k: i.k, dueDate: i.dueDate, principal: i.principal.toString(), interest: i.interest.toString(), amount: i.amount.toString() }));
  const totalInterest = binding?.totalInterest ?? plan.totalInterest.toString();
  const total = binding?.total ?? plan.total.toString();
  const reached = new Set(loan.transitions.map((t) => t.toStatus));
  const ended = loan.status === "DECLINED" || loan.status === "REJECTED" || loan.status === "CANCELLED";
  const reason = ended ? loan.transitions.at(-1)?.comment : null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/member/loans" className="text-sm underline">
          ← My loans
        </Link>
        <h1 className="mt-1 flex flex-wrap items-center gap-3 text-2xl font-semibold">
          <span className="font-mono">{loan.loanAccountNo ?? "Draft"}</span> <LoanStatusBadge status={loan.status} />
        </h1>
      </div>
      {typeof ok === "string" ? <Alert tone="success">{ok}</Alert> : null}
      {typeof error === "string" ? <Alert tone="error">{error}</Alert> : null}
      {ended ? (
        <Alert tone="error">
          {STATUS_LABEL[loan.status]}
          {reason ? `: ${reason}` : "."}
        </Alert>
      ) : null}

      {!ended ? (
        <ol className="flex flex-wrap gap-2 text-xs" aria-label="Progress">
          {STEPS.map((s) => (
            <li key={s} className={`rounded-full px-3 py-1 ${reached.has(s) ? "bg-success/10 font-semibold text-success" : "border border-border text-muted"}`}>
              {reached.has(s) ? "✓ " : ""}
              {STATUS_LABEL[s]}
            </li>
          ))}
        </ol>
      ) : null}

      <Card title="Terms">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm tabular-nums">
          <dt className="text-muted">You asked for</dt>
          <dd>
            {naira(loan.amountRequested)} over {loan.tenureRequested} months
          </dd>
          <dt className="text-muted">Approved</dt>
          <dd>{loan.amountApproved !== null ? `${naira(loan.amountApproved)} over ${loan.tenureApproved} months` : "Not yet"}</dd>
          <dt className="text-muted">Interest</dt>
          <dd>
            {formatPercent(rate)} per month on the reducing balance
            {loan.rateBps === null ? " (today's rate; fixed when approved)" : ""}
          </dd>
          <dt className="text-muted">Paid out</dt>
          <dd>{loan.d0 ? loan.d0.toISOString().slice(0, 10) : "Not yet"}</dd>
          <dt className="text-muted">Guarantor</dt>
          <dd>{loan.guarantor ? `${loan.guarantor.fullName} (${loan.guarantor.relationship})` : "—"}</dd>
        </dl>
      </Card>

      <Card title={binding ? "Your repayment schedule" : "Indicative schedule"}>
        {!binding ? (
          <p className="text-sm text-muted">Indicative only: it assumes on-time payments from today. Your binding schedule starts on the day the money is paid to you.</p>
        ) : null}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] text-left text-sm tabular-nums">
            <thead className="text-xs text-muted uppercase">
              <tr>
                <th className="py-1 pr-3">Due</th>
                <th className="py-1 pr-3 text-right">Principal</th>
                <th className="py-1 pr-3 text-right">Interest</th>
                <th className="py-1 text-right">Instalment</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.k} className="border-t border-border">
                  <td className="py-1 pr-3">{r.dueDate}</td>
                  <td className="py-1 pr-3 text-right">{naira(r.principal)}</td>
                  <td className="py-1 pr-3 text-right">{naira(r.interest)}</td>
                  <td className="py-1 text-right font-medium">{naira(r.amount)}</td>
                </tr>
              ))}
              <tr className="border-t border-border font-semibold">
                <td className="py-1" colSpan={2}>
                  Total
                </td>
                <td className="py-1 pr-3 text-right">{naira(totalInterest)}</td>
                <td className="py-1 text-right">{naira(total)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      {loan.status === "SUBMITTED" ? (
        <Card title="Cancel this application">
          <form action={cancelApplicationAction} className="flex flex-wrap gap-2">
            <input type="hidden" name="id" value={loan.id} />
            <Input name="comment" placeholder="Reason (optional)" className="min-w-56 flex-1" />
            <Button type="submit" variant="danger">
              Cancel application
            </Button>
          </form>
        </Card>
      ) : null}

      <Card title="History">
        <ol className="text-sm">
          {loan.transitions.map((t) => (
            <li key={t.id} className="border-t border-border py-2 first:border-0">
              <strong>{STATUS_LABEL[t.toStatus]}</strong> · {when(t.at)}
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
