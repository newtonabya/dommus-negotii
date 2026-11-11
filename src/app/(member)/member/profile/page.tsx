import type { Metadata } from "next";
import { Alert, Button, Card } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { memberRequests } from "@/modules/credit/members/profile-changes";
import { listSources } from "@/modules/credit/members/sources";
import { ChannelPreference } from "@/components/channel-preference";
import { requireUser } from "@/shell/auth/session";
import { withdrawChangeAction } from "./actions";
import { ChangeForm } from "./change-form";

export const metadata: Metadata = { title: "My details" };

const STATUS_STYLE = {
  PENDING: "bg-accent/10 text-accent",
  APPROVED: "bg-success/10 text-success",
  REJECTED: "bg-danger/10 text-danger",
  WITHDRAWN: "bg-background text-muted",
} as const;

const when = (d: Date) => d.toLocaleString("en-NG", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short" });

/** 0803 123 4567 style, for pre-filling the form. */
const local = (e164: string) => (e164.startsWith("+234") ? `0${e164.slice(4)}` : e164);

export default async function ProfilePage({ searchParams }: PageProps<"/member/profile">) {
  const user = await requireUser();
  const db = getDb();
  const member = await db.member.findUnique({ where: { userId: user.id }, include: { remittanceSource: true } });
  const { ok, error } = await searchParams;

  if (!member) {
    return (
      <Card title="My details">
        <p className="text-sm text-muted">There&apos;s no membership linked to this login.</p>
      </Card>
    );
  }
  const [requests, sources] = await Promise.all([memberRequests(db, member.id), listSources(db, true)]);
  const pending = requests.find((r) => r.status === "PENDING");

  const details: Array<[string, string]> = [
    ["Member number", member.memberNo],
    ["Full name", member.fullName],
    ["Phone", member.phone],
    ["Email", member.email ?? "—"],
    ["Address", member.address],
    ["MOAUM ID number", member.moaumIdNumber],
    ["ID card scan", member.idScanEvidenceId ? "On file" : "Missing — needed before you can apply for a loan"],
    ["Next of kin", `${member.nextOfKinName} · ${member.nextOfKinPhone}`],
    ["Remittance source", member.remittanceSource?.name ?? "None — pays directly"],
    ...(member.payrollStaffNo ? [["Payroll staff number", member.payrollStaffNo] as [string, string]] : []),
  ];

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">My details</h1>
      {typeof ok === "string" ? <Alert tone="success">{ok}</Alert> : null}
      {typeof error === "string" ? <Alert tone="error">{error}</Alert> : null}

      <ChannelPreference userId={user.id} page="/member/profile" staff={false} />
      <Card title="What MOAUM holds about you">
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          {details.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted">{label}</dt>
              <dd className={value.startsWith("Missing") ? "text-danger" : undefined}>{value}</dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-wrap gap-4 border-t border-border pt-3 text-sm">
          <span className="text-muted">Download a copy of your personal data:</span>
          <a href="/api/v1/me/data-copy?format=pdf" className="underline">
            PDF
          </a>
          <a href="/api/v1/me/data-copy?format=json" className="underline">
            JSON
          </a>
        </div>
      </Card>

      {member.status !== "ACTIVE" ? (
        <Alert>Changes can be requested once your membership is active.</Alert>
      ) : pending ? (
        <Card title="Your change request is waiting for review">
          <p className="text-sm text-muted">Sent {when(pending.requestedAt)}. Your details change once a Loan Officer approves it.</p>
          <ul className="text-sm">
            {pending.items.map((i) => (
              <li key={i.field}>
                {i.label}: <strong>{i.text}</strong>
              </li>
            ))}
          </ul>
          <form action={withdrawChangeAction}>
            <input type="hidden" name="id" value={pending.id} />
            <Button type="submit" variant="secondary">
              Withdraw request
            </Button>
          </form>
        </Card>
      ) : (
        <Card title="Request a change">
          <p className="text-sm text-muted">Edit what needs changing. A Loan Officer checks every change before it takes effect.</p>
          <ChangeForm
            current={{
              fullName: member.fullName,
              phone: local(member.phone),
              email: member.email ?? "",
              address: member.address,
              moaumIdNumber: member.moaumIdNumber,
              nextOfKinName: member.nextOfKinName,
              nextOfKinPhone: local(member.nextOfKinPhone),
              remittanceSourceId: member.remittanceSourceId ?? "",
            }}
            sources={sources.map((s) => ({ id: s.id, name: s.name }))}
          />
        </Card>
      )}

      {requests.filter((r) => r.status !== "PENDING").length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">Earlier requests</h2>
          {requests
            .filter((r) => r.status !== "PENDING")
            .map((r) => (
              <div key={r.id} className="rounded-lg border border-border bg-surface p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[r.status]}`}>{r.status}</span>
                  <span className="text-muted">{when(r.requestedAt)}</span>
                </div>
                <div className="mt-1">{r.items.map((i) => `${i.label}: ${i.text}`).join(" · ")}</div>
                {r.decisionNote ? <div className="mt-1 text-muted">Loan Officer: {r.decisionNote}</div> : null}
              </div>
            ))}
        </section>
      ) : null}
    </div>
  );
}
