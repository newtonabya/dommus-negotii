import { NextResponse } from "next/server";
import { MAX_EVIDENCE_BYTES } from "@/evidence/file-types";
import { getEvidenceStore, LocalEvidenceStore } from "@/evidence/store";

/**
 * Development only: serves the local evidence store's signed URLs, standing in
 * for R2's presigned PUT/GET. Answers 404 unless the local store is in use.
 */
function localStore(): LocalEvidenceStore | null {
  if (process.env.NODE_ENV === "production") return null;
  const store = getEvidenceStore();
  return store instanceof LocalEvidenceStore ? store : null;
}

export async function PUT(request: Request) {
  const store = localStore();
  if (!store) return new NextResponse(null, { status: 404 });
  const signed = store.verify(new URL(request.url).searchParams);
  if (!signed || signed.op !== "put" || !signed.key.startsWith("staging/")) {
    return NextResponse.json({ error: "Invalid or expired upload URL." }, { status: 403 });
  }
  if ((request.headers.get("content-type") ?? "") !== signed.ct) {
    return NextResponse.json({ error: "Content-Type doesn't match the signed URL." }, { status: 403 });
  }
  const body = new Uint8Array(await request.arrayBuffer());
  // Allow a little over the limit so the server-side check gives the friendly message.
  if (body.length > MAX_EVIDENCE_BYTES + 1024) return NextResponse.json({ error: "Too large." }, { status: 413 });
  await store.putFile(signed.key, body);
  return new NextResponse(null, { status: 200 });
}

export async function GET(request: Request) {
  const store = localStore();
  if (!store) return new NextResponse(null, { status: 404 });
  const signed = store.verify(new URL(request.url).searchParams);
  if (!signed || signed.op !== "get") return NextResponse.json({ error: "Invalid or expired link." }, { status: 403 });
  const bytes = await store.get(signed.key);
  if (!bytes) return new NextResponse(null, { status: 404 });
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "Content-Type": signed.ct,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(signed.fn)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
