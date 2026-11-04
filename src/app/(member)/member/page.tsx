import type { Metadata } from "next";
import { Alert, Card } from "@/components/ui/form";
import Link from "next/link";
import { getDb } from "@/lib/db";
import { todayInLagos } from "@/lib/dates";
import { formatNaira, kobo, ZERO } from "@/lib/money";
import { ledgerPrincipalOutstanding } from "@/modules/credit/loans/queries";
import { requireUser } from "@/shell/auth/session";

export const metadata: Metadata = { title: "My membership" };

export default async function MemberHome() {
  const user = await requireUser();
  const member = await getDb().member.findUnique({ where: { userId: user.id } });
  const firstName = user.name.split(" ")[0];

  if (!member) {
    return (
      <Card title={`Welcome, ${firstName}`}>
        <p className="text-sm text-muted">There&apos;s no membership linked to this login. Contact MOAUM if this is unexpected.</p>
      </Card>
    );
  }
  if (member.status === "PENDING") {
    return (
      <Card title={`Welcome, ${firstName}`}>
        <Alert>Your registration is waiting for review by a Loan Officer. We&apos;ll text you when it&apos;s done.</Alert>
      </Card>
    );
  }
  if (member.status === "DECLINED") {
    return (
      <Card title={`Welcome, ${firstName}`}>
        <Alert tone="error">Your registration was not approved{member.declineReason ? `: ${member.declineReason}` : "."}</Alert>
        <p className="text-sm text-muted">Contact MOAUM if you have questions.</p>
      </Card>
    );
  }
  const db = getDb();
  const loans = await db.loan.findMany({ where: { memberId: member.id, status: "ACTIVE" }, orderBy: { d0: "asc" } });
  const outstanding = await ledgerPrincipalOutstanding(db, loans.map((l) => l.id));
  const total = loans.reduce((t, l) => kobo(t + (outstanding.get(l.id) ?? ZERO)), ZERO);
  const today = todayInLagos();
  const next = loans
    .flatMap((l) =>
      ((l.bindingSchedule as { installments?: Array<{ k: number; dueDate: string; amount: string }> } | null)?.installments ?? [])
        .filter((i) => i.dueDate >= today)
        .slice(0, 1)
        .map((i) => ({ ...i, loanAccountNo: l.loanAccountNo, tenure: l.tenureApproved })),
    )
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1))[0];
  const actions = [
    { href: "/member/loans/apply", label: "Apply for a loan", icon: "M12 5v14M5 12h14" },
    { href: "/member/loans", label: "My loans", icon: "M3 6h18v14H3zM3 10h18" },
    { href: "/member/profile", label: "My details", icon: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" },
  ];

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-bold">Good day, {firstName}</h1>
      <section className="relative overflow-hidden rounded-2xl bg-foreground p-5 text-background">
        <p className="text-sm font-semibold opacity-80">
          Outstanding principal · {loans.length} active loan{loans.length === 1 ? "" : "s"}
        </p>
        <p className="mt-1 text-3xl font-extrabold tabular-nums">{formatNaira(total)}</p>
        <p className="mt-1 text-sm opacity-80">Interest is charged monthly on what remains.</p>
        <div className="brand-rule absolute inset-x-0 bottom-0 rounded-none" aria-hidden="true" />
      </section>
      {next ? (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-semibold text-muted">Next instalment · {next.loanAccountNo}</span>
            <span className="rounded-full bg-accent/10 px-2.5 py-0.5 text-xs font-bold text-accent">
              {next.k} of {next.tenure} · due {next.dueDate}
            </span>
          </div>
          <p className="text-2xl font-extrabold tabular-nums">{formatNaira(kobo(BigInt(next.amount)))}</p>
          <p className="text-sm text-muted">As planned at disbursement. Repayments come through your payroll remittance.</p>
        </Card>
      ) : null}
      <div className="grid grid-cols-3 gap-3">
        {actions.map((a) => (
          <Link key={a.href} href={a.href} className="flex min-h-24 flex-col items-center justify-center gap-2 rounded-2xl bg-surface p-3 text-center text-sm font-bold shadow-[0_1px_2px_rgba(35,31,32,.06),0_4px_16px_rgba(35,31,32,.06)]">
            <svg viewBox="0 0 24 24" className="h-6 w-6 text-accent" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={a.icon} />
            </svg>
            {a.label}
          </Link>
        ))}
      </div>
      {loans.length === 0 ? <Alert>No active loans. When a loan is paid out, its schedule and repayments appear here.</Alert> : null}
    </div>
  );
}
