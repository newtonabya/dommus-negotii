import type { Metadata } from "next";
import { Alert, Button } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { JOBS } from "@/jobs/definitions";
import { requireStaffPermission } from "@/shell/auth/session";
import { recentRuns } from "@/shell/jobs/runner";
import { runJobAction } from "./actions";

export const metadata: Metadata = { title: "Scheduled jobs" };

const STATUS_STYLE = {
  RUNNING: "bg-accent/10 text-accent",
  SUCCEEDED: "bg-success/10 text-success",
  FAILED: "bg-danger/10 text-danger",
} as const;

const when = (d: Date) => d.toLocaleString("en-NG", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short" });

function Summary({ value }: { value: unknown }) {
  if (!value || typeof value !== "object") return null;
  return (
    <span className="text-xs text-muted">
      {Object.entries(value as Record<string, unknown>)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join(" · ")}
    </span>
  );
}

export default async function JobsPage({ searchParams }: PageProps<"/staff/admin/jobs">) {
  await requireStaffPermission("jobs.run");
  const { ok, error } = await searchParams;
  const runs = await recentRuns(getDb());

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Scheduled jobs</h1>
        <p className="text-sm text-muted">
          These run together twice a day (about 06:00 and 18:00 Lagos time) so the database can sleep in between. Every
          run is logged here, and a failed run emails the Admins. Running one again is always safe.
        </p>
      </div>
      {typeof ok === "string" ? <Alert tone="success">{ok}</Alert> : null}
      {typeof error === "string" ? <Alert tone="error">{error}</Alert> : null}

      {JOBS.map((job) => {
        const last = runs.find((r) => r.job === job.name);
        return (
          <article key={job.name} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border bg-surface p-4">
            <div className="max-w-xl">
              <div className="font-medium">{job.label}</div>
              <p className="text-sm text-muted">{job.description}</p>
              <div className="mt-1 text-sm">
                {last ? (
                  <>
                    Last run {when(last.startedAt)}{" "}
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[last.status]}`}>{last.status}</span>{" "}
                    <Summary value={last.summary} />
                    {last.error ? <div className="text-xs text-danger">{last.error}</div> : null}
                  </>
                ) : (
                  <span className="text-muted">Not run yet.</span>
                )}
              </div>
            </div>
            <form action={runJobAction}>
              <input type="hidden" name="job" value={job.name} />
              <Button type="submit" variant="secondary">
                Run now
              </Button>
            </form>
          </article>
        );
      })}

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Recent runs</h2>
        {runs.length === 0 ? <p className="text-sm text-muted">None yet.</p> : null}
        <ul className="flex flex-col gap-1 text-sm">
          {runs.map((r) => (
            <li key={r.id}>
              {when(r.startedAt)} · <span className="font-mono text-xs">{r.job}</span>{" "}
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[r.status]}`}>{r.status}</span>{" "}
              <span className="text-xs text-muted">{r.trigger === "cron" ? "scheduled" : "run by hand"}</span>{" "}
              <Summary value={r.summary} />
              {r.error ? <span className="text-xs text-danger"> {r.error}</span> : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
