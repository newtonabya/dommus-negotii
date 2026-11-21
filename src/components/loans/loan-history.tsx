import Link from "next/link";
import { Card } from "@/components/ui/form";
import { formatNaira, kobo } from "@/lib/money";
import type { LoanHistory } from "@/modules/credit/loans/history";
import { formatDay } from "@/lib/dates";

const naira = (v: bigint) => formatNaira(kobo(v));

/** A member's loans in the order taken, with counts; used on the member's tab and the staff member page. */
export function LoanHistoryList({ history, hrefFor, who = "you" }: { history: LoanHistory; hrefFor: (loanId: string) => string; who?: string }) {
  const { rows, completed, ongoing, borrowed } = history;
  if (rows.length === 0) {
    return (
      <Card>
        <p className="text-sm text-muted">No loans taken yet. A loan appears here once it is paid out{who === "you" ? " to you" : ""}.</p>
      </Card>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <section className="grid grid-cols-3 gap-3 text-center">
        {[
          { label: rows.length === 1 ? "Loan taken" : "Loans taken", value: String(rows.length) },
          { label: "Completed", value: String(completed) },
          { label: "Ongoing", value: String(ongoing) },
        ].map((t) => (
          <div key={t.label} className="rounded-lg border border-border bg-surface p-3">
            <div className="text-2xl font-extrabold tabular-nums">{t.value}</div>
            <div className="text-xs font-semibold text-muted">{t.label}</div>
          </div>
        ))}
      </section>
      <p className="-mt-1 text-sm text-muted">Borrowed in all: {naira(borrowed)}.</p>

      <ol className="flex flex-col gap-3">
        {rows.map((r, i) => (
          <li key={r.id}>
            <Link href={hrefFor(r.id) as never} className="block rounded-lg border border-border bg-surface p-4 hover:border-accent">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold">
                  Loan {i + 1} · <span className="font-mono">{r.no}</span>
                </span>
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${r.completed ? "bg-success/10 text-success" : "bg-accent/10 text-accent"}`}>
                  {r.completed ? "Completed" : "Ongoing"}
                </span>
              </div>
              <div className="mt-1 text-sm tabular-nums">
                {naira(r.amount)} over {r.months} month{r.months === 1 ? "" : "s"}
              </div>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-sm tabular-nums">
                <dt className="text-muted">Taken</dt>
                <dd>
                  {formatDay(r.taken)}
                  {r.legacy ? <span className="text-muted"> (running before the portal; brought in at go-live)</span> : null}
                </dd>
                <dt className="text-muted">Completed</dt>
                <dd>{(r.completed && formatDay(r.completed)) || <span className="text-accent">Not yet: {naira(r.left)} principal left</span>}</dd>
                <dt className="text-muted">Repaid</dt>
                <dd>{naira(r.repaid)}</dd>
              </dl>
            </Link>
          </li>
        ))}
      </ol>
    </div>
  );
}
