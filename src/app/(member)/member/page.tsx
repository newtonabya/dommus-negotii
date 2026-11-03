import type { Metadata } from "next";
import { Alert, Card } from "@/components/ui/form";
import { getDb } from "@/lib/db";
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
  return (
    <Card title={`Welcome, ${firstName}`}>
      <p className="text-sm text-muted">
        Your membership is {member.status === "ACTIVE" ? "active" : "closed"}. Your loans, statements and receipts will appear here.
      </p>
    </Card>
  );
}
