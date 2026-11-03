import type { Metadata } from "next";
import { Alert, Button, Input } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { listPendingProfileChanges } from "@/modules/credit/members/profile-changes";
import { requireStaffPermission } from "@/shell/auth/session";
import { approveProfileChangeAction, rejectProfileChangeAction } from "./actions";

export const metadata: Metadata = { title: "Profile changes" };

const when = (d: Date) => d.toLocaleString("en-NG", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short" });

export default async function ProfileChangesPage({ searchParams }: PageProps<"/staff/members/profile-changes">) {
  const user = await requireStaffPermission("member.profileChange.approve");
  const { ok, error } = await searchParams;
  const requests = await listPendingProfileChanges(getDb());

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Profile changes</h1>
        <p className="text-sm text-muted">
          Members&apos; requests to change their contact or KYC details, oldest first. Nothing changes until you approve.
          A new phone number has already been confirmed by SMS code; a new name or MOAUM ID number comes with a supporting
          document. Check the documents before approving.
        </p>
      </div>
      {typeof ok === "string" ? <Alert tone="success">{ok}</Alert> : null}
      {typeof error === "string" ? <Alert tone="error">{error}</Alert> : null}
      {requests.length === 0 ? <p className="text-sm text-muted">No requests waiting.</p> : null}

      {requests.map((r) => (
        <article key={r.id} className="rounded-lg border border-border bg-surface p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <div className="font-medium">{r.member.fullName}</div>
              <div className="text-sm text-muted">
                {r.member.moaumIdNumber} · {r.member.phone} · asked {when(r.requestedAt)}
              </div>
            </div>
            {r.phoneVerifiedAt ? <span className="rounded-full bg-success/10 px-2.5 py-0.5 text-xs text-success">New phone confirmed by SMS</span> : null}
          </div>
          <table className="mt-3 w-full text-left text-sm">
            <thead className="text-xs text-muted uppercase">
              <tr>
                <th className="py-1 pr-4">Field</th>
                <th className="py-1 pr-4">Now</th>
                <th className="py-1">Requested</th>
              </tr>
            </thead>
            <tbody>
              {r.diff.map((d) => (
                <tr key={d.field} className="border-t border-border align-top">
                  <td className="py-1 pr-4 text-muted">{d.label}</td>
                  <td className="py-1 pr-4">{d.was}</td>
                  <td className="py-1 font-medium">
                    {d.field === "idScanEvidenceId" && d.value ? (
                      <a href={`/api/v1/evidence/${d.value}`} target="_blank" rel="noopener" className="underline">
                        Open new scan
                      </a>
                    ) : (
                      d.text
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {r.note ? <p className="mt-2 text-sm">Member&apos;s note: {r.note}</p> : null}
          {r.evidenceId ? (
            <p className="mt-1 text-sm">
              <a href={`/api/v1/evidence/${r.evidenceId}`} target="_blank" rel="noopener" className="underline">
                Open supporting document
              </a>
            </p>
          ) : null}
          {r.member.userId !== user.id ? (
            <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-border pt-4">
              <form action={approveProfileChangeAction} className="flex flex-wrap gap-2">
                <input type="hidden" name="id" value={r.id} />
                <Input name="note" placeholder="Note (optional)" className="min-w-40" />
                <Button type="submit">Approve</Button>
              </form>
              <form action={rejectProfileChangeAction} className="flex flex-1 flex-wrap gap-2">
                <input type="hidden" name="id" value={r.id} />
                <Input name="note" required minLength={5} placeholder="Reason for rejecting (sent to the member)" className="min-w-56 flex-1" />
                <Button type="submit" variant="danger">
                  Reject
                </Button>
              </form>
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted">This is your own membership: another Loan Officer must decide it.</p>
          )}
        </article>
      ))}
    </div>
  );
}
