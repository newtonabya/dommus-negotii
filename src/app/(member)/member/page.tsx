import type { Metadata } from "next";
import { Card } from "@/components/ui/form";
import { requireUser } from "@/shell/auth/session";

export const metadata: Metadata = { title: "My loans" };

export default async function MemberHome() {
  const user = await requireUser();
  return (
    <Card title={`Welcome, ${user.name.split(" ")[0]}`}>
      <p className="text-sm text-muted">Your loans, statements and receipts will appear here (Milestone 1b).</p>
    </Card>
  );
}
