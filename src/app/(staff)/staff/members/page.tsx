import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Alert, Button, Input } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { listMembers } from "@/modules/credit/members/review";
import { requireStaff } from "@/shell/auth/session";
import { hasPermission } from "@/shell/rbac/permissions";
import { activateMemberAction, declineMemberAction } from "./actions";

export const metadata: Metadata = { title: "Members" };

const STATUS_STYLE = {
  PENDING: "bg-accent/10 text-accent",
  ACTIVE: "bg-success/10 text-success",
  DECLINED: "bg-danger/10 text-danger",
  EXITED: "bg-background text-muted",
} as const;

const when = (d: Date) => d.toLocaleString("en-NG", { timeZone: "Africa/Lagos", dateStyle: "medium" });

export default async function MembersPage({ searchParams }: PageProps<"/staff/members">) {
  const user = await requireStaff();
  const canKyc = hasPermission(user.assignments, "member.kyc.read");
  if (!canKyc && !hasPermission(user.assignments, "member.directory.read")) redirect("/forbidden");
  const canReview = hasPermission(user.assignments, "member.activate");
  const canInvite = hasPermission(user.assignments, "invitation.send");
  const { ok, error } = await searchParams;
  const members = await listMembers(getDb(), canKyc);
  const pending = members.filter((m) => m.status === "PENDING").length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Members</h1>
          <p className="text-sm text-muted">
            {members.length} registered · {pending} waiting for review
          </p>
        </div>
        {canInvite ? (
          <Link href="/staff/members/invitations" className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground">
            Invitations
          </Link>
        ) : null}
      </div>
      {typeof ok === "string" ? <Alert tone="success">{ok}</Alert> : null}
      {typeof error === "string" ? <Alert tone="error">{error}</Alert> : null}

      {members.length === 0 ? <p className="text-sm text-muted">No members yet.</p> : null}
      <ul className="flex flex-col gap-3">
        {members.map((m) => (
          <li key={m.id} className="rounded-lg border border-border bg-surface p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="font-medium">{m.fullName}</div>
                <div className="text-sm text-muted">
                  {m.phone} · {m.remittanceSource} · registered {when(m.createdAt)}
                </div>
              </div>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[m.status]}`}>{m.status}</span>
            </div>

            {m.kyc ? (
              <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
                <dt className="text-muted">MOAUM ID</dt>
                <dd className="font-mono">{m.kyc.moaumIdNumber}</dd>
                <dt className="text-muted">ID card scan</dt>
                <dd>
                  {m.kyc.idScanEvidenceId ? (
                    <a href={`/api/v1/evidence/${m.kyc.idScanEvidenceId}`} target="_blank" rel="noopener" className="underline">
                      Open scan
                    </a>
                  ) : (
                    <span className="text-danger">Missing — KYC incomplete</span>
                  )}
                </dd>
                <dt className="text-muted">Address</dt>
                <dd>{m.kyc.address}</dd>
                <dt className="text-muted">Email</dt>
                <dd>{m.kyc.email ?? "—"}</dd>
                <dt className="text-muted">Next of kin</dt>
                <dd>
                  {m.kyc.nextOfKinName} · {m.kyc.nextOfKinPhone}
                </dd>
                <dt className="text-muted">Consent (NDPA)</dt>
                <dd>{when(m.kyc.consentAt)}</dd>
                {m.kyc.declineReason ? (
                  <>
                    <dt className="text-muted">Declined because</dt>
                    <dd>{m.kyc.declineReason}</dd>
                  </>
                ) : null}
              </dl>
            ) : null}

            {canReview && m.status === "PENDING" ? (
              <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-border pt-4">
                <form action={activateMemberAction}>
                  <input type="hidden" name="memberId" value={m.id} />
                  <Button type="submit">Activate</Button>
                </form>
                <form action={declineMemberAction} className="flex flex-1 flex-wrap gap-2">
                  <input type="hidden" name="memberId" value={m.id} />
                  <Input name="reason" required minLength={5} placeholder="Reason for declining (sent to the applicant)" className="min-w-56 flex-1" />
                  <Button type="submit" variant="danger">
                    Decline
                  </Button>
                </form>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
