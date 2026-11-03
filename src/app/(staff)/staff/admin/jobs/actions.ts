"use server";

import { getDb } from "@/lib/db";
import { JOBS } from "@/jobs/definitions";
import { authorizeAction } from "@/shell/auth/session";
import { runJob } from "@/shell/jobs/runner";
import { field, runAndReturn } from "../../run-action";

const PAGE = "/staff/admin/jobs";

export async function runJobAction(form: FormData) {
  await runAndReturn(PAGE, async () => {
    const actor = await authorizeAction("jobs.run");
    const job = JOBS.find((j) => j.name === field(form, "job"));
    if (!job) throw new Error("Unknown job");
    const run = await runJob(getDb(), job, actor.id);
    return run.status === "SUCCEEDED" ? `${job.label}: done.` : `${job.label}: ${run.status === "RUNNING" ? "already running." : `failed — ${run.error}`}`;
  });
}
