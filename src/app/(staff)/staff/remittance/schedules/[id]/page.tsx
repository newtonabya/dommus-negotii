import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert, Card } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { formatNaira, kobo } from "@/lib/money";
import { requireStaffPermission } from "@/shell/auth/session";

export const metadata: Metadata = { title: "Schedule" };

const naira = (v: bigint) => formatNaira(kobo(v));
const day = (d: Date) => d.toISOString().slice(0, 10);
const LODGEMENT = { UNVERIFIED: "Not yet verified", BANK_VERIFIED: "Verified at the bank", APPLIED: "Applied" } as const;

export default async function SchedulePage({ params, searchParams }: PageProps<"/staff/remittance/schedules/[id]">) {
  await requireStaffPermission("credit.read");
  const { id } = await params;
  const { ok } = await searchParams;
  const schedule = await getDb().remittanceSchedule.findUnique({
    where: { id },
    include: {
      remittanceSource: true,
      advice: { select: { adviceReference: true, evidenceId: true } },
      rows: { orderBy: { rowNo: "asc" }, include: { member: { select: { fullName: true, moaumIdNumber: true } }, loan: { select: { id: true, loanAccountNo: true, legacyAccountNo: true } } } },
      lodgements: { include: { bankAccount: true } },
    },
  });
  if (!schedule) notFound();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/staff/remittance" className="text-sm underline">
          ← Remittance
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">
          Schedule <span className="font-mono">{schedule.scheduleReference}</span>
        </h1>
        <p className="text-sm text-muted">
          {schedule.remittanceSource.code} · {schedule.monthCovered} · {schedule.type} · {naira(schedule.controlTotal)} in {schedule.rowCount} rows ·
          advice{" "}
          <a className="underline" href={`/api/v1/evidence/${schedule.advice.evidenceId}`} target="_blank" rel="noopener">
            {schedule.advice.adviceReference}
          </a>{" "}
          ·{" "}
          <a className="underline" href={`/api/v1/evidence/${schedule.evidenceId}`} target="_blank" rel="noopener">
            schedule file
          </a>{" "}
          · posted {schedule.postedAt.toLocaleString("en-NG", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short" })}
        </p>
        <p className="font-mono text-xs break-all text-muted">SHA-256 {schedule.checksum}</p>
      </div>
      {typeof ok === "string" ? <Alert tone="success">{ok}</Alert> : null}

      <Card title="Rows">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[600px] text-left text-sm tabular-nums">
            <thead className="text-xs text-muted uppercase">
              <tr>
                <th className="py-1 pr-3">Row</th>
                <th className="py-1 pr-3">Member</th>
                <th className="py-1 pr-3">Applied to</th>
                <th className="py-1 pr-3">Date</th>
                <th className="py-1 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {schedule.rows.map((r) => (
                <tr key={r.id} className={`border-t border-border ${r.reversedAt ? "text-muted line-through" : ""}`}>
                  <td className="py-1 pr-3">{r.rowNo}</td>
                  <td className="py-1 pr-3">
                    {r.member.fullName} <span className="font-mono text-xs text-muted">{r.member.moaumIdNumber}</span>
                  </td>
                  <td className="py-1 pr-3">
                    {r.loan && !r.toCredit ? (
                      <Link className="font-mono underline" href={`/staff/loans/${r.loan.id}`}>
                        {r.loan.loanAccountNo ?? r.loan.legacyAccountNo}
                      </Link>
                    ) : (
                      "Overpayment Credit"
                    )}
                  </td>
                  <td className="py-1 pr-3">{day(r.paymentDate)}</td>
                  <td className="py-1 text-right">{naira(r.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Lodgements">
        {schedule.lodgements.length === 0 ? (
          <p className="text-sm text-muted">None declared.</p>
        ) : (
          <ul className="text-sm tabular-nums">
            {schedule.lodgements.map((l) => (
              <li key={l.id} className="border-t border-border py-2 first:border-0">
                {l.bankAccount.bankName} {l.bankAccount.accountNumber} · {day(l.depositDate)} · {l.reference} · {naira(l.amount)} ·{" "}
                <span className="text-muted">{LODGEMENT[l.status]}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
