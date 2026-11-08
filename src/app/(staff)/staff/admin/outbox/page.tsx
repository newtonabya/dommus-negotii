import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Alert, Card } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { isStaging } from "@/lib/stage";
import { requireStaffPermission } from "@/shell/auth/session";
import { listStagingOutbox, OUTBOX_HOURS } from "@/shell/notifications/staging-outbox";

export const metadata: Metadata = { title: "Staging outbox" };

const when = (d: Date) => d.toLocaleString("en-NG", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "medium" });

/** STAGING ONLY: the SMS and emails the app would have sent, so testers can use links and codes. */
export default async function StagingOutboxPage() {
  if (!isStaging()) notFound();
  await requireStaffPermission("users.manage");
  const messages = await listStagingOutbox(getDb());

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Staging outbox</h1>
        <p className="text-sm text-muted">
          Staging never sends SMS or email. Every message the app would have sent appears here for {OUTBOX_HOURS} hours, so
          testers can open invitation links, set passwords and enter sign-in codes. This page and its data do not exist in
          production.
        </p>
      </div>
      <Alert tone="info">Codes expire after 5 minutes and invitation links after 7 days, as in production. Newest first; reload for new messages.</Alert>
      {messages.length === 0 ? <p className="text-sm text-muted">No messages in the last {OUTBOX_HOURS} hours.</p> : null}
      {messages.map((m) => (
        <Card key={m.id}>
          <div className="text-xs text-muted">
            {m.channel} to <span className="font-mono">{m.recipient}</span> · {m.template} · {when(m.createdAt)}
          </div>
          {m.subject ? <div className="mt-1 font-semibold">{m.subject}</div> : null}
          <pre className="mt-2 text-sm break-words whitespace-pre-wrap">{m.text}</pre>
        </Card>
      ))}
    </div>
  );
}
