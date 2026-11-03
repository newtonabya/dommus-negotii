"use client";

import { useRef, useState } from "react";
import { Alert } from "@/components/ui/form";
import { beginEvidenceUpload, finishEvidenceUpload } from "@/evidence/actions";
import { ACCEPT_ATTRIBUTE, MAX_EVIDENCE_BYTES, typeFromName } from "@/evidence/file-types";

export interface UploadedEvidence {
  evidenceId: string;
  filename: string;
  sha256: string;
  sizeBytes: number;
  reused: boolean;
}

type Status = { tone: "info" | "error" | "success"; text: string } | null;

function formatSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Uploads one evidence file (PDF, JPG, PNG, XLSX, CSV, ≤10 MB): the browser
 * sends it straight to storage with a 5-minute URL, then the server checks it,
 * computes its SHA-256 and files it. Reports the stored file to `onUploaded`.
 */
export function EvidenceUpload({
  label = "Attach evidence",
  onUploaded,
}: {
  label?: string;
  onUploaded?: (file: UploadedEvidence) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    if (!typeFromName(file.name)) return setStatus({ tone: "error", text: "Only PDF, JPG, PNG, XLSX and CSV files are accepted." });
    if (file.size > MAX_EVIDENCE_BYTES) return setStatus({ tone: "error", text: "The file is larger than 10 MB." });

    setBusy(true);
    setStatus({ tone: "info", text: `Uploading ${file.name} (${formatSize(file.size)})…` });
    try {
      const begun = await beginEvidenceUpload({ filename: file.name, size: file.size });
      if (!begun.ok) return setStatus({ tone: "error", text: begun.error });

      const put = await fetch(begun.value.url, { method: "PUT", headers: begun.value.headers, body: file });
      if (!put.ok) return setStatus({ tone: "error", text: "The upload was interrupted. Please try again." });

      setStatus({ tone: "info", text: "Checking the file…" });
      const finished = await finishEvidenceUpload(begun.value.uploadId);
      if (!finished.ok) return setStatus({ tone: "error", text: finished.error });

      const { reused, sha256 } = finished.value;
      setStatus({
        tone: "success",
        text: `${file.name} stored${reused ? " (an identical file was already on record, so that copy is used)" : ""}. Checksum ${sha256.slice(0, 12)}…`,
      });
      onUploaded?.(finished.value);
    } catch {
      setStatus({ tone: "error", text: "The upload failed. Check your connection and try again." });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">{label}</span>
        <input
          ref={input}
          type="file"
          accept={ACCEPT_ATTRIBUTE}
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
          className="text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-surface file:px-3 file:py-1.5 file:text-sm"
        />
        <span className="text-xs text-muted">PDF, JPG, PNG, XLSX or CSV, up to 10 MB.</span>
      </label>
      {status ? <Alert tone={status.tone}>{status.text}</Alert> : null}
    </div>
  );
}
