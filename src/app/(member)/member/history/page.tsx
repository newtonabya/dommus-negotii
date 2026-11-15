import type { Metadata } from "next";
import { LoanHistoryList } from "@/components/loans/loan-history";
import { getDb } from "@/lib/db";
import { loanHistory } from "@/modules/credit/loans/history";
import { requireUser } from "@/shell/auth/session";

export const metadata: Metadata = { title: "Loan history" };

/** Every loan the member has taken from MOAUM, in the order taken. */
export default async function LoanHistoryPage() {
  const user = await requireUser();
  const db = getDb();
  const member = await db.member.findUnique({ where: { userId: user.id } });
  const history = member ? await loanHistory(db, member.id) : { rows: [], completed: 0, ongoing: 0, borrowed: 0n };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Loan history</h1>
        <p className="text-sm text-muted">Every loan you have taken from MOAUM, in the order you took them.</p>
      </div>
      <LoanHistoryList history={history} hrefFor={(id) => `/member/loans/${id}`} />
    </div>
  );
}
