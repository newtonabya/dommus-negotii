"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Alert, Button } from "@/components/ui/form";

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface ImportPreview {
  batchId: string;
  rows: Array<{ rowNo: number; fullName: string; phone: string; errors: string[] }>;
  validCount: number;
}

/**
 * Upload a CSV/XLSX list → dry run with per-row errors → commit (PRD F5).
 * `allOrNothing` disables the commit while any row has errors.
 */
export function ImportPanel({
  preview,
  commit,
  verb,
  noun,
  allOrNothing,
}: {
  preview: (form: FormData) => Promise<Result<ImportPreview>>;
  commit: (batchId: string) => Promise<Result<string>>;
  /** The commit button reads "<verb> <n> <noun>", e.g. "Send 3 invitations". */
  verb: string;
  /** Singular and plural, e.g. ["invitation", "invitations"]. */
  noun: [string, string];
  allOrNothing: boolean;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<ImportPreview | null>(null);
  const [notice, setNotice] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function check(file: File) {
    setBusy(true);
    setNotice(null);
    setResult(null);
    const form = new FormData();
    form.set("file", file);
    try {
      const checked = await preview(form);
      if (checked.ok) setResult(checked.value);
      else setNotice({ tone: "error", text: checked.error });
    } catch {
      setNotice({ tone: "error", text: "The upload failed. Check your connection and try again." });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  async function confirm() {
    if (!result) return;
    setBusy(true);
    try {
      const done = await commit(result.batchId);
      setNotice({ tone: done.ok ? "success" : "error", text: done.ok ? done.value : done.error });
      setResult(null);
      router.refresh();
    } catch {
      setNotice({ tone: "error", text: "The request failed. Check your connection, then look at the list before trying again." });
    } finally {
      setBusy(false);
    }
  }

  const errorRows = result ? result.rows.filter((r) => r.errors.length > 0) : [];
  const blocked = !result || result.validCount === 0 || (allOrNothing && errorRows.length > 0);

  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Upload the filled-in list</span>
        <input
          ref={input}
          type="file"
          accept=".csv,.xlsx"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void check(file);
          }}
          className="text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-surface file:px-3 file:py-1.5 file:text-sm"
        />
        <span className="text-xs text-muted">CSV or XLSX, up to 2 MB and 2,000 rows. Nothing is sent until you confirm.</span>
      </label>
      {busy && !result ? <Alert tone="info">Checking the file…</Alert> : null}
      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}

      {result ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            {result.rows.length} row{result.rows.length === 1 ? "" : "s"} checked: <strong>{result.validCount} ready</strong>
            {errorRows.length ? (
              <>
                , <strong className="text-danger">{errorRows.length} with errors</strong>
                {allOrNothing ? " — fix them in the file and upload it again; nothing is imported while any row has errors." : " — they will be skipped."}
              </>
            ) : null}
          </p>
          <div className="max-h-96 overflow-auto rounded-lg border border-border bg-surface">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="sticky top-0 border-b border-border bg-surface text-xs text-muted uppercase">
                <tr>
                  <th className="px-3 py-2">Row</th>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Phone</th>
                  <th className="px-3 py-2">Result</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r) => (
                  <tr key={r.rowNo} className="border-b border-border align-top last:border-0">
                    <td className="px-3 py-2 font-mono text-xs">{r.rowNo}</td>
                    <td className="px-3 py-2">{r.fullName}</td>
                    <td className="px-3 py-2 font-mono text-xs">{r.phone}</td>
                    <td className="px-3 py-2">
                      {r.errors.length ? (
                        <ul className="text-xs text-danger">
                          {r.errors.map((e) => (
                            <li key={e}>{e}</li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-xs text-success">OK</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button type="button" disabled={blocked || busy} onClick={() => void confirm()}>
              {busy ? "Working…" : `${verb} ${result.validCount} ${result.validCount === 1 ? noun[0] : noun[1]}`}
            </Button>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => setResult(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
