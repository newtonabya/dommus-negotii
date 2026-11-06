import { Card } from "@/components/ui/form";
import { formatNaira, type Kobo } from "@/lib/money";
import type { loanLiveState } from "@/modules/credit/loans/repayments";

type Live = NonNullable<Awaited<ReturnType<typeof loanLiveState>>>;

/** Where the loan stands today and every repayment with its split (PRD F6, F9). */
export function RepaymentsCard({ live, forMember = false }: { live: Live; forMember?: boolean }) {
  const { state, repayments, payoff } = live;
  const n = (v: Kobo) => formatNaira(v);
  const arrears = state.principalArrears + state.interestArrears;
  return (
    <>
      <Card title={forMember ? "Where your loan stands" : "Balance today"}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm tabular-nums">
          <dt className="text-muted">Principal outstanding</dt>
          <dd className="font-semibold">{n(state.outstandingPrincipal)}</dd>
          <dt className="text-muted">Overdue</dt>
          <dd className={arrears > 0n ? "font-semibold text-danger" : ""}>
            {arrears > 0n ? `${n(state.principalArrears)} principal + ${n(state.interestArrears)} interest` : "Nothing overdue"}
          </dd>
          <dt className="text-muted">Interest charged so far</dt>
          <dd>
            {n(state.interestCharged)} <span className="text-muted">(paid {n(state.interestPaid)})</span>
          </dd>
          {state.overpaymentCredit > 0n ? (
            <>
              <dt className="text-muted">Overpayment Credit</dt>
              <dd>{n(state.overpaymentCredit)}</dd>
            </>
          ) : null}
          {state.status === "CLOSED" ? (
            <>
              <dt className="text-muted">Closed</dt>
              <dd className="font-semibold text-success">✓ Repaid in full on {state.closedOn}</dd>
            </>
          ) : null}
          {payoff ? (
            <>
              <dt className="text-muted">To pay it off</dt>
              <dd>
                <span className="font-semibold">{n(payoff.amount)}</span>{" "}
                <span className="text-muted">
                  ({n(payoff.principal)} principal + {n(payoff.interest)} interest), if paid by {payoff.validUntil}
                </span>
              </dd>
            </>
          ) : null}
        </dl>
      </Card>
      <Card title="Repayments">
        {repayments.length === 0 ? (
          <p className="text-sm text-muted">No repayments yet. Payroll deductions appear here as soon as the month&apos;s schedule is posted.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-left text-sm tabular-nums">
              <thead className="text-xs text-muted uppercase">
                <tr>
                  <th className="py-1 pr-3">Date</th>
                  <th className="py-1 pr-3 text-right">Amount</th>
                  <th className="py-1 pr-3 text-right">Interest</th>
                  <th className="py-1 pr-3 text-right">Principal</th>
                  <th className="py-1">Reference</th>
                </tr>
              </thead>
              <tbody>
                {repayments.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="py-1 pr-3">{r.date}</td>
                    <td className="py-1 pr-3 text-right font-medium">{n(r.amount)}</td>
                    <td className="py-1 pr-3 text-right">{n(r.interest)}</td>
                    <td className="py-1 pr-3 text-right">
                      {n(r.principal)}
                      {r.credit > 0n ? <div className="text-xs text-muted">+ {n(r.credit)} to credit</div> : null}
                    </td>
                    <td className="py-1 font-mono text-xs">{r.reference}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
