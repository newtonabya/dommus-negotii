import type { Metadata } from "next";
import Link from "next/link";
import { guarantorAnswer } from "@/components/loans/guarantor-answer";
import { LoanStatusBadge } from "@/components/loans/status-badge";
import { Card, buttonClass } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { formatNaira, kobo } from "@/lib/money";
import { requireUser } from "@/shell/auth/session";

export const metadata: Metadata = { title: "My loans" };

export default async function MyLoansPage() {
  const user = await requireUser();
  const db = getDb();
  const member = await db.member.findUnique({ where: { userId: user.id } });
  const loans = member
    ? await db.loan.findMany({ where: { memberId: member.id, status: { not: "CANCELLED" } }, include: { guarantor: true }, orderBy: { createdAt: "desc" } })
    : [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-semibold">My loans</h1>
        {member?.status === "ACTIVE" ? (
          <Link href="/member/loans/apply" className={buttonClass()}>
            Apply for a loan
          </Link>
        ) : null}
      </div>
      {loans.length === 0 ? (
        <Card>
          <p className="text-sm text-muted">No loans yet. When you apply, you&apos;ll see the amount, the schedule and every repayment here.</p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {loans.map((l) => (
            <li key={l.id}>
              <Link
                href={l.status === "DRAFT" ? `/member/loans/apply?draft=${l.id}` : `/member/loans/${l.id}`}
                className="block rounded-lg border border-border bg-surface p-4 hover:border-accent"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono font-medium">{l.loanAccountNo ?? "Draft application"}</span>
                  <LoanStatusBadge status={l.status} />
                </div>
                <div className="mt-1 text-sm tabular-nums">
                  {formatNaira(kobo(l.amountApproved ?? l.amountRequested))} over {l.tenureApproved ?? l.tenureRequested} months
                  <span className="text-muted"> · {l.amountApproved !== null ? "approved" : "requested"}</span>
                </div>
                {l.guarantor && ["SUBMITTED", "VERIFIED", "RECOMMENDED", "APPROVED"].includes(l.status) ? (
                  <div className={`text-sm ${guarantorAnswer(l.guarantor, l.status).tone}`}>Guarantor ({l.guarantor.fullName}): {guarantorAnswer(l.guarantor, l.status).short}</div>
                ) : null}
                {l.status === "DRAFT" ? <div className="text-sm text-accent">Continue the draft →</div> : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
