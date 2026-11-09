import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Alert, Button, Card, Input } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { daysBetween, localDate, todayInLagos } from "@/lib/dates";
import { formatNaira, kobo } from "@/lib/money";
import { requireStaff } from "@/shell/auth/session";
import { listExceptions } from "@/shell/exceptions/exceptions";
import { hasPermission } from "@/shell/rbac/permissions";
import { closeExceptionAction, reviewExceptionAction } from "./actions";

export const metadata: Metadata = { title: "Exceptions" };

const FILE = "block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-accent/10 file:px-3 file:py-2 file:text-accent";
const TYPE_LABEL: Record<string, string> = {
  SHORTFALL: "Shortfall from a source",
  EXCESS: "Excess from a source",
  IN_BANK_NOT_IN_SYSTEM: "In the bank, not in the records",
  IN_SYSTEM_NOT_IN_BANK: "In the records, not in the bank",
  AMOUNT_MISMATCH: "Amounts differ",
  DUPLICATE: "Duplicate",
  LEDGER_BANK_DIFFERENCE: "Bank and ledger differ",
  DUPLICATE_EVIDENCE: "Same evidence used twice",
  EVIDENCE_TAMPERED: "Evidence file changed",
};
const STATUS = { OPEN: "Open", UNDER_REVIEW: "Under review", CLOSED: "Closed" } as const;

export default async function ExceptionsPage({ searchParams }: PageProps<"/staff/exceptions">) {
  const user = await requireStaff();
  const can = (a: Parameters<typeof hasPermission>[1]) => hasPermission(user.assignments, a);
  if (!can("credit.read") && !can("exception.close")) redirect("/forbidden");
  const q = await searchParams;
  const view = q.view === "closed" ? "CLOSED" : "ACTIVE";
  const items = await listExceptions(getDb(), { status: view });
  const today = todayInLagos();
  const age = (d: Date) => daysBetween(localDate(d.toISOString().slice(0, 10)), today);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Exceptions</h1>
        <p className="text-sm text-muted">
          Raised by the system (reconciliation, evidence checks). The Finance Manager reviews each one with notes and evidence; only the
          GMD closes it, with the evidence that confirms it and a reason. Closing never changes the ledger or any balance: if a
          correction is needed, it is posted first through its own approval.
        </p>
      </div>
      {typeof q.ok === "string" ? <Alert tone="success">{q.ok}</Alert> : null}
      {typeof q.error === "string" ? <Alert tone="error">{q.error}</Alert> : null}
      <nav className="flex gap-3 text-sm" aria-label="View">
        <a className={view === "ACTIVE" ? "font-semibold" : "underline"} href="/staff/exceptions">
          Open and under review
        </a>
        <a className={view === "CLOSED" ? "font-semibold" : "underline"} href="/staff/exceptions?view=closed">
          Closed
        </a>
      </nav>
      {items.length === 0 ? <p className="text-sm text-muted">None.</p> : null}
      <ul className="flex flex-col gap-3">
        {items.map((e) => {
          const details = e.details as { readyToClose?: boolean; month?: string };
          return (
            <li key={e.id}>
              <Card>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-xs font-semibold tracking-wide text-muted uppercase">{TYPE_LABEL[e.type] ?? e.type}</span>
                  <span className="text-xs text-muted">
                    {STATUS[e.status]} · raised {e.raisedAt.toISOString().slice(0, 10)} · {e.status === "CLOSED" ? "" : `${age(e.raisedAt)} day(s) old`}
                    {details.month ? ` · ${details.month}` : ""}
                  </span>
                </div>
                <p className="mt-1 text-sm font-medium">{e.title}</p>
                {e.amount !== null ? <p className="text-sm tabular-nums">Amount now: {formatNaira(kobo(e.amount))}</p> : null}
                {details.readyToClose && e.status !== "CLOSED" ? <p className="text-sm font-semibold text-success">✓ Resolved in the records: ready to close.</p> : null}
                {e.reviewNote ? <pre className="mt-2 text-xs whitespace-pre-wrap text-muted">{e.reviewNote}</pre> : null}
                {e.status === "CLOSED" ? (
                  <p className="mt-2 text-sm">
                    Closed: {e.closeReason}
                    {e.closeEvidenceId ? (
                      <>
                        {" "}
                        ·{" "}
                        <a className="underline" href={`/api/v1/evidence/${e.closeEvidenceId}`} target="_blank" rel="noopener">
                          evidence
                        </a>
                      </>
                    ) : null}
                  </p>
                ) : null}
                {e.status !== "CLOSED" && can("exception.review") ? (
                  <form action={reviewExceptionAction.bind(null, e.id)} className="mt-3 flex flex-wrap items-end gap-2">
                    <Input name="note" required minLength={5} placeholder="What you found" className="min-w-56 flex-1" />
                    <input type="file" name="evidence" accept=".pdf,.jpg,.jpeg,.png,.xlsx,.csv" className={`${FILE} w-56`} aria-label="Supporting evidence (optional)" />
                    <Button type="submit" variant="secondary">
                      Add review note
                    </Button>
                  </form>
                ) : null}
                {e.status === "UNDER_REVIEW" && can("exception.close") ? (
                  <form action={closeExceptionAction.bind(null, e.id)} className="mt-3 flex flex-wrap items-end gap-2">
                    <Input name="reason" required minLength={10} placeholder="Why it can be closed" className="min-w-56 flex-1" />
                    <input type="file" name="evidence" required accept=".pdf,.jpg,.jpeg,.png,.xlsx,.csv" className={`${FILE} w-56`} aria-label="Confirming evidence" />
                    <Button type="submit">Close</Button>
                  </form>
                ) : null}
                {e.status === "OPEN" && can("exception.close") ? <p className="mt-2 text-xs text-muted">The Finance Manager reviews it before it can be closed.</p> : null}
              </Card>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
