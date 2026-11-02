"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Button } from "@/components/ui/form";
import { authClient } from "@/shell/auth/auth-client";
import { describeDevice } from "@/shell/auth/device";

interface SessionRow {
  id: string;
  token: string;
  createdAt: Date;
  updatedAt: Date;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** Lists the user's sessions and lets them sign out any of them (PRD F1). */
export function SessionsList() {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [list, me] = await Promise.all([authClient.listSessions(), authClient.getSession()]);
    if (list.error) setError(list.error.message ?? "Could not load sessions.");
    else setSessions(list.data as SessionRow[]);
    setCurrent(me.data?.session.token ?? null);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading external data once on mount
    void load();
  }, [load]);

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!sessions) return <p className="text-sm text-muted">Loading…</p>;

  return (
    <ul className="flex flex-col divide-y divide-border text-sm">
      {sessions.map((s) => (
        <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
          <div>
            <div className="font-medium">
              {describeDevice(s.userAgent)} {s.token === current ? <span className="text-xs text-success">(this device)</span> : null}
            </div>
            <div className="text-xs text-muted">
              {s.ipAddress ?? "unknown IP"} · last active{" "}
              {new Date(s.updatedAt).toLocaleString("en-NG", { timeZone: "Africa/Lagos" })}
            </div>
          </div>
          {s.token !== current ? (
            <Button
              variant="secondary"
              className="px-2 py-1 text-xs"
              onClick={async () => {
                await authClient.revokeSession({ token: s.token });
                await load();
              }}
            >
              Sign out
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
