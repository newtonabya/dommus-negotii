import type { Metadata } from "next";
import { Card } from "@/components/ui/form";
import { requireStaff } from "@/shell/auth/session";
import { SessionsList } from "@/components/sessions-list";

export const metadata: Metadata = { title: "My account" };

export default async function AccountPage() {
  const user = await requireStaff();
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">My account</h1>
      <Card title="Details">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-muted">Name</dt>
          <dd>{user.name}</dd>
          <dt className="text-muted">Email</dt>
          <dd>{user.email}</dd>
          <dt className="text-muted">Two-factor login</dt>
          <dd>{user.twoFactorEnabled ? "On" : "Off"}</dd>
        </dl>
      </Card>
      <Card title="Where you're signed in">
        <SessionsList />
      </Card>
    </div>
  );
}
