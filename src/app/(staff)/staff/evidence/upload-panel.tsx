"use client";

import { useRouter } from "next/navigation";
import { EvidenceUpload } from "@/components/evidence-upload";

/** Uploads a file and refreshes the list. Records attach evidence through their own forms. */
export function UploadPanel() {
  const router = useRouter();
  return (
    <>
      <p className="text-sm text-muted">
        Files uploaded here are stored and listed but not attached to any record. Forms for loans, schedules and
        lodgements attach their evidence directly.
      </p>
      <EvidenceUpload label="Choose a file" onUploaded={() => router.refresh()} />
    </>
  );
}
