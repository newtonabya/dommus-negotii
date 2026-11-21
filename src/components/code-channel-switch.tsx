"use client";

import { useState } from "react";

type Channel = "SMS" | "EMAIL";

/**
 * "Didn't get it? Send a new code by email / by SMS" under a code box. Shows
 * only the channels that can work: no SMS while texts are switched off, no
 * email when we know there is none (`email === false`; undefined = unknown).
 */
export function CodeChannelSwitch(props: {
  sms: boolean;
  email?: boolean;
  /** Where the last code went, if known: that channel is offered as "a new code", the other as "instead". */
  current?: Channel;
  send: (channel: Channel) => Promise<{ ok: true; message?: string } | { ok: false; error: string }>;
}) {
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const options: Channel[] = [...(props.sms ? (["SMS"] as const) : []), ...(props.email !== false ? (["EMAIL"] as const) : [])];
  if (options.length === 0) return null;

  async function send(channel: Channel) {
    setBusy(true);
    setNote(null);
    const result = await props.send(channel);
    setBusy(false);
    setNote(result.ok ? { tone: "ok", text: result.message ?? (channel === "EMAIL" ? "A new code is on its way to your email, if your account has one." : "A new code is on its way by SMS.") } : { tone: "error", text: result.error });
  }

  const label = (c: Channel) => {
    const how = c === "EMAIL" ? "by email" : "by SMS";
    if (options.length === 1 || props.current === c) return `Send a new code ${how}`;
    return `Send it ${how} instead`;
  };

  return (
    <div className="flex flex-col gap-1 text-sm">
      <p className="text-muted">Didn&apos;t get it?</p>
      <div className="flex flex-wrap gap-4">
        {options.map((c) => (
          <button key={c} type="button" className="underline disabled:opacity-50" disabled={busy} onClick={() => void send(c)}>
            {label(c)}
          </button>
        ))}
      </div>
      {note ? <p className={note.tone === "error" ? "text-danger" : "text-muted"} role="status">{note.text}</p> : null}
    </div>
  );
}
