import { formatNaira, kobo } from "@/lib/money";
import type { ActualSchedule, ActualStatus, NextPayment } from "@/modules/credit/domain/projection";
import { formatDay } from "@/lib/dates";
import { instalmentLabel } from "@/modules/credit/domain/schedule";

const naira = (v: bigint | string) => formatNaira(kobo(BigInt(v)));

const STATUS: Record<ActualStatus, { label: string; tone: string }> = {
  PAID: { label: "Paid", tone: "text-success" },
  PART_PAID: { label: "Part paid", tone: "text-accent" },
  OVERDUE: { label: "Overdue", tone: "text-danger" },
  DUE: { label: "Due", tone: "text-accent" },
  TO_COME: { label: "To come", tone: "text-muted" },
};

/**
 * The actual schedule: each instalment as it really fell due (after any
 * overpayment re-spread the principal), what was paid and what is left, with
 * the amount the payout schedule had planned beside it.
 */
export function ActualScheduleTable({
  actual,
  planned,
  next,
  forMember = false,
}: {
  actual: ActualSchedule;
  /** The binding schedule's instalment amounts, by instalment number. */
  planned: Map<number, string>;
  next: NextPayment | null;
  forMember?: boolean;
}) {
  const left = actual.rows.reduce((t, r) => t + r.left, 0n);
  const ahead = actual.paidAhead.reduce((t, p) => t + p.amount, 0n);
  const repaid = actual.rows.reduce((t, r) => t + r.paid, 0n) + ahead + actual.overpaid;
  const differs = actual.rows.some((r) => planned.has(r.k) && BigInt(planned.get(r.k) as string) !== r.amount) || actual.paidAhead.length > 0;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        {differs
          ? `Repayments have not followed the schedule set at payout, so the instalments have changed: paying more lowers the ones after it, paying less leaves the shortfall due. This is what ${forMember ? "you owe" : "is owed"} now.`
          : "Repayments so far follow the schedule set at payout."}
        {next ? ` Next payment ${naira(next.amount)}${next.overdue > 0n ? `, including ${naira(next.overdue)} overdue` : `, due ${formatDay(next.dueDate)}`}.` : ""}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm tabular-nums">
          <thead className="text-xs text-muted uppercase">
            <tr>
              <th className="py-1 pr-3">#</th>
              <th className="py-1 pr-3">Due</th>
              <th className="py-1 pr-3 text-right">At payout</th>
              <th className="py-1 pr-3 text-right">Actual instalment</th>
              <th className="py-1 pr-3 text-right">Paid</th>
              <th className="py-1 pr-3 text-right">Left</th>
              <th className="py-1">Status</th>
            </tr>
          </thead>
          <tbody>
            {actual.rows.map((r) => {
              const plan = planned.get(r.k);
              const changed = plan !== undefined && BigInt(plan) !== r.amount;
              return (
                <tr key={r.k} className="border-t border-border">
                  <td className="py-1 pr-3">{instalmentLabel(r.k)}</td>
                  <td className="py-1 pr-3 whitespace-nowrap">{formatDay(r.dueDate)}</td>
                  <td className={`py-1 pr-3 text-right ${changed ? "text-muted line-through" : "text-muted"}`}>{plan !== undefined ? naira(plan) : "—"}</td>
                  <td className="py-1 pr-3 text-right font-medium" title={`Principal ${naira(r.principal)} + interest ${naira(r.interest)}`}>
                    {naira(r.amount)}
                  </td>
                  <td className="py-1 pr-3 text-right">{r.paid > 0n ? naira(r.paid) : "—"}</td>
                  <td className="py-1 pr-3 text-right">{r.left > 0n ? naira(r.left) : "—"}</td>
                  <td className={`py-1 font-semibold ${STATUS[r.status].tone}`}>{STATUS[r.status].label}</td>
                </tr>
              );
            })}
            <tr className="border-t border-border font-semibold">
              <td className="py-1" colSpan={5}>
                Still to pay
              </td>
              <td className="py-1 pr-3 text-right">{naira(left)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-sm">
        Repaid so far: <strong>{naira(repaid)}</strong>
        {ahead > 0n ? `, of which ${naira(ahead)} ahead of time` : ""}.
      </p>
      {actual.paidAhead.length > 0 ? (
        <p className="text-sm">
          Paid ahead of time:{" "}
          {actual.paidAhead.map((p, i) => (
            <span key={p.date}>
              {i > 0 ? "; " : ""}
              <strong>{naira(p.amount)}</strong> on {p.date}
            </span>
          ))}
          . It went straight to the principal and is not shown against any one instalment: that is why the later instalments are smaller.
        </p>
      ) : null}
      {actual.overpaid > 0n ? <p className="text-sm">Paid beyond what was owed: {naira(actual.overpaid)}, kept as Overpayment Credit.</p> : null}
    </div>
  );
}
