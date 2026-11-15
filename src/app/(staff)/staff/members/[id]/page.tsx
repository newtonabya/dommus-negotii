import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { LoanHistoryList } from "@/components/loans/loan-history";
import { getDb } from "@/lib/db";
import { loanHistory } from "@/modules/credit/loans/history";
import { requireStaff } from "@/shell/auth/session";
import { hasPermission } from "@/shell/rbac/permissions";

export const metadata: Metadata = { title: "Member" };

/** One member: who they are, and every loan they have taken from MOAUM in the order taken. */
export default async function StaffMemberPage({ params }: PageProps<"/staff/members/[id]">) {
  const user = await requireStaff();
  if (!hasPermission(user.assignments, "member.kyc.read") && !hasPermission(user.assignments, "member.directory.read")) redirect("/forbidden");
  const { id } = await params;
  const db = getDb();
  const member = await db.member.findUnique({ where: { id }, include: { remittanceSource: { select: { name: true, code: true } } } });
  if (!member) notFound();
  const history = await loanHistory(db, member.id);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/staff/members" className="text-sm underline">
          ← Members
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">{member.fullName}</h1>
        <p className="text-sm text-muted">
          <span className="font-mono">{member.memberNo}</span>
          {member.payrollStaffNo ? (
            <>
              {" "}
              · payroll PIN <span className="font-mono">{member.payrollStaffNo}</span>
            </>
          ) : null}{" "}
          · {member.remittanceSource ? `${member.remittanceSource.name} (${member.remittanceSource.code})` : "Pays directly"} · {member.phone} · {member.status}
        </p>
      </div>
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Loan history</h2>
        <p className="-mt-2 text-sm text-muted">Every loan {member.fullName.split(" ")[0]} has taken from MOAUM, in the order taken.</p>
        <LoanHistoryList history={history} hrefFor={(loanId) => `/staff/loans/${loanId}`} who={member.fullName} />
      </section>
    </div>
  );
}
