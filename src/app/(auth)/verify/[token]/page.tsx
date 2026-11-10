import type { Metadata } from "next";
import { headers } from "next/headers";
import { Alert, Card } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { allowShared } from "@/lib/rate-limit";
import { verifyReceipt } from "@/modules/credit/reports/member-documents";
import { clientIp } from "@/shell/auth/security";

export const metadata: Metadata = { title: "Check a receipt", robots: { index: false, follow: false } };

/**
 * Public receipt check (PRD F13): shows only whether the receipt is genuine,
 * its number, amount and date, and a masked name. Rate limited per address.
 */
export default async function VerifyReceiptPage({ params }: PageProps<"/verify/[token]">) {
  const { token } = await params;
  const ip = clientIp(await headers()) ?? "unknown";
  if (!(await allowShared(getDb(), `verify:${ip}`, 20, 60_000))) {
    return (
      <Card title="Check a receipt">
        <Alert tone="error">Too many checks from this connection. Try again in a minute.</Alert>
      </Card>
    );
  }
  const result = await verifyReceipt(getDb(), decodeURIComponent(token));
  return (
    <Card title="Check a receipt">
      {result.genuine ? (
        <div className="flex flex-col gap-3">
          <Alert tone={result.reversed ? "info" : "success"}>
            {result.reversed ? "This receipt was genuine, but the payment was later reversed by a correction." : "This is a genuine MOAUM Credit Super Store receipt."}
          </Alert>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm tabular-nums">
            <dt className="text-muted">Receipt number</dt>
            <dd className="font-mono">{result.number}</dd>
            <dt className="text-muted">Amount</dt>
            <dd>{result.amount}</dd>
            <dt className="text-muted">Payment date</dt>
            <dd>{result.date}</dd>
            <dt className="text-muted">Member</dt>
            <dd>{result.member}</dd>
          </dl>
        </div>
      ) : (
        <Alert tone="error">This receipt could not be verified. It was not issued by MOAUM Credit Super Store, or the code was changed.</Alert>
      )}
    </Card>
  );
}
