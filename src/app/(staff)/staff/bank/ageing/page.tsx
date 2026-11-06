import type { Metadata } from "next";
import Link from "next/link";
import { Card } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { formatNaira, kobo } from "@/lib/money";
import { AGE_BUCKETS, ageingReport } from "@/modules/credit/banking/matching";
import { requireStaffPermission } from "@/shell/auth/session";

export const metadata: Metadata = { title: "Bank ageing" };

const naira = (v: bigint) => formatNaira(kobo(v));
const day = (d: Date) => d.toISOString().slice(0, 10);

export default async function AgeingPage() {
  await requireStaffPermission("credit.read");
  const report = await ageingReport(getDb());
  const sections = [
    {
      title: "Unapplied Bank Credits",
      hint: "Money in the bank with no matching lodgement and no member tag.",
      data: report.unappliedCredits,
      rows: report.unappliedCredits.rows.map((r) => ({ id: r.id, date: day(r.transactionDate), what: `${r.narration}${r.reference ? ` · ${r.reference}` : ""}`, account: r.bankAccount.accountNumber, amount: r.amount, days: r.days, bucket: r.bucket })),
    },
    {
      title: "Unverified Lodgements",
      hint: "Lodgements declared on a schedule that no bank credit has confirmed yet.",
      data: report.unverifiedLodgements,
      rows: report.unverifiedLodgements.rows.map((r) => ({ id: r.id, date: day(r.depositDate), what: `${r.reference} · schedule ${r.schedule?.scheduleReference ?? "—"}`, account: r.bankAccount.accountNumber, amount: r.amount, days: r.days, bucket: r.bucket })),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/staff/bank" className="text-sm underline">
          ← Bank
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Ageing report</h1>
        <p className="text-sm text-muted">As at {report.asOf}. Days are counted from the bank date or the deposit date.</p>
      </div>
      {sections.map((s) => (
        <Card key={s.title} title={`${s.title}: ${naira(s.data.total)}`}>
          <p className="mb-3 text-sm text-muted">{s.hint}</p>
          <dl className="mb-3 grid grid-cols-2 gap-2 text-sm tabular-nums sm:grid-cols-4">
            {AGE_BUCKETS.map((b) => (
              <div key={b} className="rounded-lg border border-border p-2">
                <dt className="text-xs text-muted">{b} days</dt>
                <dd className="font-semibold">{naira(s.data.totals[b])}</dd>
              </div>
            ))}
          </dl>
          {s.rows.length === 0 ? (
            <p className="text-sm text-muted">None.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-sm tabular-nums">
                <thead className="text-xs text-muted uppercase">
                  <tr>
                    <th className="py-1 pr-3">Date</th>
                    <th className="py-1 pr-3">What</th>
                    <th className="py-1 pr-3">Account</th>
                    <th className="py-1 pr-3 text-right">Amount</th>
                    <th className="py-1 text-right">Days</th>
                  </tr>
                </thead>
                <tbody>
                  {s.rows.map((r) => (
                    <tr key={r.id} className="border-t border-border">
                      <td className="py-1 pr-3">{r.date}</td>
                      <td className="py-1 pr-3">{r.what}</td>
                      <td className="py-1 pr-3 font-mono text-xs">{r.account}</td>
                      <td className="py-1 pr-3 text-right">{naira(r.amount)}</td>
                      <td className="py-1 text-right">{r.days}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}
