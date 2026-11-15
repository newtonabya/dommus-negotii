import type { Metadata } from "next";
import Link from "next/link";
import { Card } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { formatNaira, kobo } from "@/lib/money";
import { loanLiveState } from "@/modules/credit/loans/repayments";
import { requireUser } from "@/shell/auth/session";

export const metadata: Metadata = { title: "Loan history" };

const naira = (v: bigint) => formatNaira(kobo(v));
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");
/** Legacy loans were running before the portal; they are brought in at go-live with this purpose. */
const LEGACY_PURPOSE = "Loan brought in from MOAUM's records at go-live";

/**
 * Every loan the member has taken from MOAUM (paid out, or brought in at
 * go-live), in the order they were taken: completed ones with the date they
 * were cleared, and any still running.
 */
export default async function LoanHistoryPage() {
  const user = await requireUser();
  const db = getDb();
  const member = await db.member.findUnique({ where: { userId: user.id } });
  const loans = member
    ? await db.loan.findMany({
        where: { memberId: member.id, status: { in: ["ACTIVE", "CLOSED"] }, d0: { not: null } },
        orderBy: [{ d0: "asc" }, { createdAt: "asc" }],
      })
    : [];
  const live = await Promise.all(loans.map((l) => loanLiveState(db, l)));
  const rows = loans.map((l, i) => {
    const state = live[i];
    return {
      id: l.id,
      no: l.loanAccountNo ?? l.legacyAccountNo ?? "—",
      legacy: l.purpose === LEGACY_PURPOSE,
      amount: l.amountApproved ?? l.amountRequested,
      months: l.tenureApproved ?? l.tenureRequested,
      taken: day(l.d0),
      completed: l.status === "CLOSED" ? day(l.closedOn) || state?.state.closedOn || "" : "",
      repaid: (state?.repayments ?? []).reduce((t, r) => t + r.amount, 0n),
      left: state?.state.status === "ACTIVE" ? state.state.outstandingPrincipal : 0n,
    };
  });
  const completed = rows.filter((r) => r.completed).length;
  const ongoing = rows.length - completed;
  const borrowed = rows.reduce((t, r) => t + r.amount, 0n);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Loan history</h1>
        <p className="text-sm text-muted">Every loan you have taken from MOAUM, in the order you took them.</p>
      </div>

      {rows.length === 0 ? (
        <Card>
          <p className="text-sm text-muted">No loans taken yet. A loan appears here once it is paid out to you.</p>
        </Card>
      ) : (
        <>
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
          <p className="-mt-3 text-sm text-muted">Borrowed in all: {naira(borrowed)}.</p>

          <ol className="flex flex-col gap-3">
            {rows.map((r, i) => (
              <li key={r.id}>
                <Link href={`/member/loans/${r.id}`} className="block rounded-lg border border-border bg-surface p-4 hover:border-accent">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold">
                      Loan {i + 1} · <span className="font-mono">{r.no}</span>
                    </span>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${r.completed ? "bg-success/10 text-success" : "bg-accent/10 text-accent"}`}
                    >
                      {r.completed ? "Completed" : "Ongoing"}
                    </span>
                  </div>
                  <div className="mt-1 text-sm tabular-nums">
                    {naira(r.amount)} over {r.months} month{r.months === 1 ? "" : "s"}
                  </div>
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-sm tabular-nums">
                    <dt className="text-muted">Taken</dt>
                    <dd>
                      {r.taken}
                      {r.legacy ? <span className="text-muted"> (running before the portal; brought in at go-live)</span> : null}
                    </dd>
                    <dt className="text-muted">Completed</dt>
                    <dd>{r.completed || <span className="text-accent">Not yet: {naira(r.left)} principal left</span>}</dd>
                    <dt className="text-muted">Repaid</dt>
                    <dd>{naira(r.repaid)}</dd>
                  </dl>
                </Link>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
