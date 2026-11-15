import type { Metadata } from "next";
import { Alert, Button, Card } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { formatNaira, kobo } from "@/lib/money";
import { guaranteeByToken } from "@/modules/credit/loans/guarantee";
import { answerGuaranteeAction } from "./actions";

export const metadata: Metadata = { title: "Guarantee a loan", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** A guarantor (member or not) accepts or declines here, from the link in their SMS. */
export default async function GuaranteePage({ params, searchParams }: PageProps<"/guarantee/[token]">) {
  const { token } = await params;
  const { error } = await searchParams;
  const found = await guaranteeByToken(getDb(), token);
  if (!found) {
    return (
      <Card title="Guarantee a loan">
        <Alert tone="error">This link is not valid. Ask the applicant to send you a new request.</Alert>
      </Card>
    );
  }
  const { guarantor, loan, state } = found;
  const first = guarantor.fullName.split(" ")[0];
  return (
    <Card title={`Hello ${first}`}>
      <div className="flex flex-col gap-4">
        {typeof error === "string" ? <Alert tone="error">{error}</Alert> : null}
        <p className="text-sm">
          <span className="font-semibold">{loan.member.fullName}</span> has named you as guarantor for a loan from MOAUM Credit Super Store.
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm tabular-nums">
          <dt className="text-muted">Application</dt>
          <dd className="font-mono">{loan.loanAccountNo ?? "—"}</dd>
          <dt className="text-muted">Amount asked for</dt>
          <dd>{formatNaira(kobo(loan.amountRequested))}</dd>
          <dt className="text-muted">To repay over</dt>
          <dd>{loan.tenureRequested} months</dd>
        </dl>
        {state === "open" ? (
          <>
            <p className="text-sm text-muted">
              By accepting, you agree to stand as guarantor: if {loan.member.fullName.split(" ")[0]} does not repay, MOAUM may look to you for what is
              owed. No one may guarantee more than two active loans at a time.
            </p>
            <div className="flex flex-wrap gap-3">
              <form action={answerGuaranteeAction.bind(null, token, true)}>
                <Button type="submit">I accept</Button>
              </form>
              <form action={answerGuaranteeAction.bind(null, token, false)}>
                <Button type="submit" variant="secondary">
                  I decline
                </Button>
              </form>
            </div>
          </>
        ) : state === "accepted" ? (
          <Alert tone="success">You accepted this guarantee. Thank you. There is nothing more to do.</Alert>
        ) : state === "declined" ? (
          <Alert tone="info">You declined this guarantee. The applicant has been told.</Alert>
        ) : state === "expired" ? (
          <Alert tone="error">This link has expired. Ask the applicant or MOAUM&apos;s Loan Officer to send a new one.</Alert>
        ) : (
          <Alert tone="info">This loan is closed: there is nothing to answer.</Alert>
        )}
      </div>
    </Card>
  );
}
