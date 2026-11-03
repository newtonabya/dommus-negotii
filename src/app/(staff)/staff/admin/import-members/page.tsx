import type { Metadata } from "next";
import { ImportPanel } from "@/components/import-panel";
import { Card } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { listImportBatches } from "@/modules/credit/imports/batches";
import { requireStaffPermission } from "@/shell/auth/session";
import { commitMemberImportAction, previewMemberImportAction } from "./actions";

export const metadata: Metadata = { title: "Import members" };

const STATUS_LABEL = { PREVIEWED: "Checked, not imported", COMMITTED: "Imported", REJECTED: "Rejected — nothing imported" } as const;

const when = (d: Date) => d.toLocaleString("en-NG", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short" });

export default async function ImportMembersPage() {
  await requireStaffPermission("member.import.upload");
  const batches = await listImportBatches(getDb(), "MEMBERS");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Import members</h1>
        <p className="text-sm text-muted">
          Bring existing MOAUM members in from a list. Imported members are active straight away (they were already
          members), and each gets an SMS link to set up their login, accept the data protection notice and, if their
          record has no ID scan, upload one. The import is all or nothing: if any row has an error, nothing is imported.
          The uploaded file is kept as evidence.
        </p>
      </div>

      <Card title="Upload a member list">
        <p className="text-sm text-muted">
          Use the template (
          <a href="/api/v1/templates/members.xlsx" className="underline">
            Excel
          </a>{" "}
          or{" "}
          <a href="/api/v1/templates/members.csv" className="underline">
            CSV
          </a>
          ). Its Instructions sheet explains every column. Use NONE as the remittance source code for members who pay
          directly.
        </p>
        <ImportPanel
          preview={previewMemberImportAction}
          commit={commitMemberImportAction}
          verb="Import"
          noun={["member", "members"]}
          allOrNothing
        />
      </Card>

      <div className="overflow-x-auto rounded-lg border border-border bg-surface">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b border-border text-xs text-muted uppercase">
            <tr>
              <th className="px-4 py-3">File</th>
              <th className="px-4 py-3">Rows</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Uploaded</th>
            </tr>
          </thead>
          <tbody>
            {batches.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-muted">
                  No imports yet.
                </td>
              </tr>
            ) : null}
            {batches.map((b) => (
              <tr key={b.id} className="border-b border-border align-top last:border-0">
                <td className="px-4 py-3">
                  {b.evidenceId ? (
                    <a href={`/api/v1/evidence/${b.evidenceId}`} target="_blank" rel="noopener" className="underline">
                      {b.filename}
                    </a>
                  ) : (
                    b.filename
                  )}
                </td>
                <td className="px-4 py-3">
                  {b.rowCount}
                  {b.errorRowCount ? <span className="text-danger"> · {b.errorRowCount} with errors</span> : null}
                </td>
                <td className="px-4 py-3">
                  {STATUS_LABEL[b.status]}
                  {b.committedAt ? <div className="text-xs text-muted">{when(b.committedAt)}</div> : null}
                </td>
                <td className="px-4 py-3">
                  {when(b.uploadedAt)}
                  <div className="text-xs text-muted">by {b.uploadedByName}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
