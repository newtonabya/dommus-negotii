import type { Metadata } from "next";
import { Card } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { listAnnouncements } from "@/modules/credit/announcements";
import { listSources } from "@/modules/credit/members/sources";
import { requireStaffPermission } from "@/shell/auth/session";
import { AnnouncementForm } from "./announcement-form";

export const metadata: Metadata = { title: "Announcements" };

const when = (d: Date) => d.toLocaleString("en-NG", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short" });

/** The GMD and the Secretary send an SMS and/or email to active members (PRD F15). */
export default async function AnnouncementsPage() {
  await requireStaffPermission("announcement.send");
  const db = getDb();
  const [sources, sent] = await Promise.all([listSources(db, true), listAnnouncements(db)]);
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Announcements</h1>
      <Card title="Send an announcement">
        <p className="mb-4 text-sm text-muted">
          For notices to members, such as a meeting date. Only active members receive it. You see how many members and SMS units it takes before anything is sent.
        </p>
        <AnnouncementForm sources={sources.map((s) => ({ id: s.id, label: `${s.name} (${s.code})` }))} />
      </Card>
      <Card title={`Sent (${sent.length})`}>
        {sent.length === 0 ? (
          <p className="text-sm text-muted">No announcements yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm tabular-nums">
              <thead className="text-muted">
                <tr>
                  <th className="py-2 pr-4 font-medium">Sent</th>
                  <th className="py-2 pr-4 font-medium">To</th>
                  <th className="py-2 pr-4 font-medium">Announcement</th>
                  <th className="py-2 pr-4 font-medium">Members</th>
                  <th className="py-2 pr-4 font-medium">SMS units</th>
                  <th className="py-2 font-medium">Delivery</th>
                </tr>
              </thead>
              <tbody>
                {sent.map((a) => (
                  <tr key={a.id} className="border-t border-border align-top">
                    <td className="py-2 pr-4 whitespace-nowrap">{when(a.createdAt)}</td>
                    <td className="py-2 pr-4">{a.audienceLabel}</td>
                    <td className="py-2 pr-4">
                      {a.subject ? <span className="font-medium">{a.subject}: </span> : null}
                      {a.body}
                    </td>
                    <td className="py-2 pr-4">{a.recipientCount}</td>
                    <td className="py-2 pr-4">{a.smsUnits}</td>
                    <td className="py-2">
                      {a.sent} sent{a.waiting ? `, ${a.waiting} waiting` : ""}
                      {a.failed ? `, ${a.failed} failed` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
