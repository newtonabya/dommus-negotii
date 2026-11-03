import type { Metadata } from "next";
import { Card } from "@/components/ui/form";
import { listEvidence } from "@/evidence/service";
import { getDb } from "@/lib/db";
import { requireStaffPermission } from "@/shell/auth/session";
import { hasPermission } from "@/shell/rbac/permissions";
import { UploadPanel } from "./upload-panel";

export const metadata: Metadata = { title: "Evidence" };

function formatSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const when = (d: Date) => d.toLocaleString("en-NG", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short" });

export default async function EvidencePage() {
  const user = await requireStaffPermission("evidence.read");
  const files = await listEvidence(getDb());

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Evidence</h1>
        <p className="text-sm text-muted">
          Every file is stored once by its SHA-256 checksum, is never deleted, and is re-checked each time it&apos;s
          opened. Opening a file is recorded in the audit trail.
        </p>
      </div>

      {hasPermission(user.assignments, "evidence.upload") ? (
        <Card title="Upload">
          <UploadPanel />
        </Card>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-border bg-surface">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b border-border text-xs text-muted uppercase">
            <tr>
              <th className="px-4 py-3">File</th>
              <th className="px-4 py-3">Uploaded</th>
              <th className="px-4 py-3">SHA-256</th>
              <th className="px-4 py-3">Used by</th>
            </tr>
          </thead>
          <tbody>
            {files.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-muted">
                  No evidence yet.
                </td>
              </tr>
            ) : null}
            {files.map((f) => (
              <tr key={f.id} className="border-b border-border align-top last:border-0">
                <td className="px-4 py-3">
                  <a href={`/api/v1/evidence/${f.id}`} target="_blank" rel="noopener" className="font-medium underline">
                    {f.filename}
                  </a>
                  <div className="text-xs text-muted">
                    {f.mimeType.split("/").pop()?.split(".").pop()?.toUpperCase()} · {formatSize(f.sizeBytes)}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div>{f.uploadedByName}</div>
                  <div className="text-xs text-muted">{when(f.uploadedAt)}</div>
                </td>
                <td className="px-4 py-3">
                  <code className="font-mono text-xs break-all" title={f.sha256}>
                    {f.sha256.slice(0, 16)}…
                  </code>
                </td>
                <td className="px-4 py-3 text-xs">
                  {f.links.length === 0 ? (
                    <span className="text-muted">Not attached to a record yet</span>
                  ) : (
                    <ul className="flex flex-col gap-0.5">
                      {f.links.map((l) => (
                        <li key={`${l.submissionKey}:${l.entityType}:${l.kind}`}>
                          {l.kind === "PRIMARY" ? "Primary" : "Supporting"} · {l.submissionKey}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
