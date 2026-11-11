"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, Field, Input, Select, inputClass } from "@/components/ui/form";
import { previewAnnouncementAction, sendAnnouncementAction } from "./actions";

interface Preview {
  audienceLabel: string;
  recipientCount: number;
  smsCount: number;
  smsUnitsEach: number;
  smsUnits: number;
  emailCount: number;
  withoutEmail: number;
  token: string;
}

/** Write, check the recipients and cost, then confirm (PRD F15). */
export function AnnouncementForm({ sources }: { sources: Array<{ id: string; label: string }> }) {
  const router = useRouter();
  const [audience, setAudience] = useState("ALL");
  const [viaSms, setViaSms] = useState(true);
  const [viaEmail, setViaEmail] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [notice, setNotice] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const input = { audience, viaSms, viaEmail, subject, body };
  // Any edit after the check means the check no longer describes what would be sent.
  const edit = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPreview(null);
  };

  async function check() {
    setBusy(true);
    setNotice(null);
    const result = await previewAnnouncementAction(input);
    setBusy(false);
    if (result.ok) setPreview(result.value);
    else setNotice({ tone: "error", text: result.error });
  }

  async function send() {
    if (!preview) return;
    setBusy(true);
    const result = await sendAnnouncementAction(input, preview.token);
    setBusy(false);
    if (result.ok) {
      setNotice({ tone: "success", text: result.value });
      setPreview(null);
      setBody("");
      setSubject("");
      router.refresh();
    } else {
      setNotice({ tone: "error", text: result.error });
      setPreview(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
      <Field label="Send to">
        <Select id="announcement-audience" value={audience} onChange={(e) => edit(setAudience)(e.target.value)}>
          <option value="ALL">All active members</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              Active members on {s.label}
            </option>
          ))}
        </Select>
      </Field>
      <fieldset className="flex flex-wrap gap-6 text-sm">
        <legend className="mb-1 font-medium">Send by</legend>
        <label className="flex items-center gap-2">
          <input id="announcement-sms" type="checkbox" checked={viaSms} onChange={(e) => edit(setViaSms)(e.target.checked)} /> SMS
        </label>
        <label className="flex items-center gap-2">
          <input id="announcement-email" type="checkbox" checked={viaEmail} onChange={(e) => edit(setViaEmail)(e.target.checked)} /> Email
        </label>
      </fieldset>
      {viaEmail ? (
        <Field label="Email subject">
          <Input id="announcement-subject" value={subject} maxLength={120} onChange={(e) => edit(setSubject)(e.target.value)} />
        </Field>
      ) : null}
      <Field label="Announcement" hint={`${body.trim().length} of 600 characters. An SMS starts with “MOAUM Credit Super Store: ”. Plain letters and numbers cost least; write NGN instead of the naira sign.`}>
        <textarea id="announcement-body" className={inputClass} rows={5} maxLength={600} value={body} onChange={(e) => edit(setBody)(e.target.value)} />
      </Field>

      {preview ? (
        <div className="flex flex-col gap-3 rounded-md border border-border p-4">
          <p className="font-medium">Confirm before sending</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm tabular-nums">
            <dt className="text-muted">To</dt>
            <dd>{preview.audienceLabel}</dd>
            <dt className="text-muted">Members who will receive it</dt>
            <dd>{preview.recipientCount}</dd>
            {viaSms ? (
              <>
                <dt className="text-muted">SMS</dt>
                <dd>
                  {preview.smsCount} message(s) × {preview.smsUnitsEach} unit(s) = {preview.smsUnits} SMS unit(s)
                </dd>
              </>
            ) : null}
            {viaEmail ? (
              <>
                <dt className="text-muted">Emails</dt>
                <dd>
                  {preview.emailCount}
                  {preview.withoutEmail > 0 ? ` (${preview.withoutEmail} member(s) have no email address)` : ""}
                </dd>
              </>
            ) : null}
          </dl>
          <div className="flex flex-wrap gap-3">
            <Button type="button" onClick={send} disabled={busy}>
              {busy ? "Sending…" : `Send to ${preview.recipientCount} member(s)`}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setPreview(null)} disabled={busy}>
              Go back and edit
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button type="button" onClick={check} disabled={busy}>
            {busy ? "Checking…" : "Check recipients and cost"}
          </Button>
        </div>
      )}
    </div>
  );
}
