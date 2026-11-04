import type { Metadata } from "next";
import Link from "next/link";
import { LoanStatusBadge } from "@/components/loans/status-badge";
import { getDb } from "@/lib/db";
import { formatNaira, kobo } from "@/lib/money";
import type { LoanStatus } from "@/modules/credit/domain/loan-status";
import { listLoans } from "@/modules/credit/loans/queries";
import { requireStaffPermission } from "@/shell/auth/session";
import { hasPermission, type Action } from "@/shell/rbac/permissions";

export const metadata: Metadata = { title: "Loans" };

/** What each role acts on next (PRD F7). */
const MY_QUEUE: Array<{ action: Action; statuses: LoanStatus[]; label: string }> = [
  { action: "loan.verify", statuses: ["SUBMITTED", "VERIFIED"], label: "To verify or recommend" },
  { action: "loan.approve", statuses: ["RECOMMENDED"], label: "To approve" },
  { action: "voucher.disbursement.prepare", statuses: ["APPROVED"], label: "To pay out" },
  { action: "voucher.disbursement.verify", statuses: ["DISBURSEMENT_PENDING"], label: "Vouchers to verify" },
];

const FILTERS: Array<{ key: string; label: string; statuses: LoanStatus[] | null }> = [
  { key: "all", label: "All", statuses: null },
  { key: "review", label: "In review", statuses: ["SUBMITTED", "VERIFIED", "RECOMMENDED"] },
  { key: "payout", label: "Approved / paying out", statuses: ["APPROVED", "DISBURSEMENT_PENDING"] },
  { key: "active", label: "Active", statuses: ["ACTIVE"] },
  { key: "ended", label: "Closed or not approved", statuses: ["CLOSED", "DECLINED", "REJECTED", "CANCELLED"] },
];

const when = (d: Date) => d.toLocaleString("en-NG", { timeZone: "Africa/Lagos", dateStyle: "medium" });

export default async function LoansPage({ searchParams }: PageProps<"/staff/loans">) {
  const user = await requireStaffPermission("credit.read");
  const { show } = await searchParams;
  const mine = MY_QUEUE.find((q) => hasPermission(user.assignments, q.action));
  const filter = FILTERS.find((f) => f.key === show) ?? (mine ? { key: "mine", label: mine.label, statuses: mine.statuses } : FILTERS[0]!);
  const loans = await listLoans(getDb(), filter.statuses);
  const tabs = mine ? [{ key: "mine", label: mine.label }, ...FILTERS] : FILTERS;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Loans</h1>
          <p className="text-sm text-muted">Applications move: submitted → verified → recommended → approved → voucher → active.</p>
        </div>
        {hasPermission(user.assignments, "loan.application.captureAssisted") ? (
          <Link href="/staff/loans/new" className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground">
            Capture paper application
          </Link>
        ) : null}
      </div>
      <nav className="flex flex-wrap gap-2 text-sm" aria-label="Filter loans">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={`/staff/loans?show=${t.key}`}
            aria-current={t.key === filter.key ? "page" : undefined}
            className={`rounded-full px-3 py-1 ${t.key === filter.key ? "bg-accent text-accent-foreground" : "border border-border bg-surface"}`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      <div className="overflow-x-auto rounded-lg border border-border bg-surface">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-border text-xs text-muted uppercase">
            <tr>
              <th className="px-4 py-3">Loan</th>
              <th className="px-4 py-3">Member</th>
              <th className="px-4 py-3 text-right">Amount</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Updated</th>
            </tr>
          </thead>
          <tbody>
            {loans.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-muted">
                  Nothing here.
                </td>
              </tr>
            ) : null}
            {loans.map((l) => (
              <tr key={l.id} className="border-b border-border last:border-0">
                <td className="px-4 py-3">
                  <Link href={`/staff/loans/${l.id}`} className="font-mono underline">
                    {l.loanAccountNo ?? "Draft"}
                  </Link>
                  {l.assisted ? <div className="text-xs text-muted">Paper application</div> : null}
                </td>
                <td className="px-4 py-3">
                  {l.member.fullName}
                  <div className="text-xs text-muted">{l.member.moaumIdNumber}</div>
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {formatNaira(kobo(l.amountApproved ?? l.amountRequested))}
                  <div className="text-xs text-muted">
                    {l.amountApproved !== null ? `approved · ${l.tenureApproved} mo` : `requested · ${l.tenureRequested} mo`}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <LoanStatusBadge status={l.status} />
                </td>
                <td className="px-4 py-3">{when(l.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
