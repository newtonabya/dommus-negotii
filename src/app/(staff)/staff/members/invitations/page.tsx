import type { Metadata } from "next";
import { ImportPanel } from "@/components/import-panel";
import { Alert, Button, Card, Field, Input, Select } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { listInvitations } from "@/modules/credit/members/invitations";
import { MAX_INVITES_PER_SENDER_PER_DAY } from "@/modules/credit/members/rules";
import { listSources } from "@/modules/credit/members/sources";
import { requireStaffPermission } from "@/shell/auth/session";
import {
  previewBulkInvitationsAction,
  resendInvitationAction,
  revokeInvitationAction,
  sendBulkInvitationsAction,
  sendInvitationAction,
} from "./actions";

export const metadata: Metadata = { title: "Invitations" };

const STATE_LABEL = {
  pending: "Sent",
  opened: "Opened",
  registered: "Registered",
  expired: "Expired",
  revoked: "Revoked",
} as const;

const when = (d: Date) => d.toLocaleString("en-NG", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short" });

export default async function InvitationsPage({ searchParams }: PageProps<"/staff/members/invitations">) {
  await requireStaffPermission("invitation.send");
  const { ok, error } = await searchParams;
  const db = getDb();
  const [invitations, sources] = await Promise.all([listInvitations(db), listSources(db, true)]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Member invitations</h1>
        <p className="text-sm text-muted">
          Each invitation is a personal link sent by SMS (and email if you add one). It works once, only with the invited
          phone number, and expires after 7 days. Registering doesn&apos;t make someone a member: a Loan Officer reviews
          every registration.
        </p>
      </div>
      {typeof ok === "string" ? <Alert tone="success">{ok}</Alert> : null}
      {typeof error === "string" ? <Alert tone="error">{error}</Alert> : null}

      <Card title="Invite someone">
        <form action={sendInvitationAction} className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name">
            <Input name="fullName" required minLength={3} autoComplete="off" />
          </Field>
          <Field label="Mobile number" hint="Nigerian mobile, e.g. 0803 123 4567">
            <Input name="phone" required inputMode="tel" autoComplete="off" />
          </Field>
          <Field label="Email (optional)">
            <Input name="email" type="email" autoComplete="off" />
          </Field>
          <Field label="Remittance source (optional)" hint="Pre-selects it on their form; they can change it.">
            <Select name="remittanceSourceId" defaultValue="">
              <option value="">Not specified</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="sm:col-span-2">
            <Button type="submit">Send invitation</Button>
          </div>
        </form>
      </Card>

      <Card title="Invite a list">
        <p className="text-sm text-muted">
          Download the template (
          <a href="/api/v1/templates/invitations.xlsx" className="underline">
            Excel
          </a>{" "}
          or{" "}
          <a href="/api/v1/templates/invitations.csv" className="underline">
            CSV
          </a>
          ), fill in one person per row and upload it. You&apos;ll see every row checked before anything is sent; rows with
          errors are skipped. You can send up to {MAX_INVITES_PER_SENDER_PER_DAY} invitations a day.
        </p>
        <ImportPanel
          preview={previewBulkInvitationsAction}
          commit={sendBulkInvitationsAction}
          verb="Send"
          noun={["invitation", "invitations"]}
          allOrNothing={false}
        />
      </Card>

      <div className="overflow-x-auto rounded-lg border border-border bg-surface">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-border text-xs text-muted uppercase">
            <tr>
              <th className="px-4 py-3">Invitee</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Sent</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {invitations.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-muted">
                  No invitations yet.
                </td>
              </tr>
            ) : null}
            {invitations.map((inv) => (
              <tr key={inv.id} className="border-b border-border align-top last:border-0">
                <td className="px-4 py-3">
                  <div className="font-medium">
                    {inv.fullName}
                    {inv.type === "ACTIVATION" ? <span className="ml-2 text-xs font-normal text-muted">(login set-up for an imported member)</span> : null}
                  </div>
                  <div className="text-xs text-muted">
                    {inv.phone}
                    {inv.email ? ` · ${inv.email}` : ""}
                    {inv.remittanceSource ? ` · ${inv.remittanceSource.name}` : ""}
                  </div>
                </td>
                <td className="px-4 py-3">
                  {STATE_LABEL[inv.state]}
                  {!inv.lastSendOk && inv.state !== "registered" ? (
                    <div className="text-xs text-danger">Last SMS not accepted</div>
                  ) : null}
                  {inv.state === "pending" || inv.state === "opened" ? (
                    <div className="text-xs text-muted">Expires {when(inv.expiresAt)}</div>
                  ) : null}
                </td>
                <td className="px-4 py-3">
                  <div>{when(inv.lastSentAt)}</div>
                  <div className="text-xs text-muted">
                    by {inv.sentByName}
                    {inv.sendCount > 1 ? ` · sent ${inv.sendCount} times` : ""}
                  </div>
                </td>
                <td className="px-4 py-3">
                  {inv.state !== "registered" && inv.state !== "revoked" ? (
                    <div className="flex justify-end gap-2">
                      <form action={resendInvitationAction}>
                        <input type="hidden" name="id" value={inv.id} />
                        <Button type="submit" variant="secondary" className="px-2 py-1 text-xs">
                          Resend
                        </Button>
                      </form>
                      <form action={revokeInvitationAction}>
                        <input type="hidden" name="id" value={inv.id} />
                        <Button type="submit" variant="danger" className="px-2 py-1 text-xs">
                          Revoke
                        </Button>
                      </form>
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
