import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Alert, Button, Card, Field, Input } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { listImportBatches } from "@/modules/credit/imports/batches";
import { requireStaff } from "@/shell/auth/session";
import { hasPermission } from "@/shell/rbac/permissions";
import { getDateSetting } from "@/shell/settings/settings";
import { previewLegacyAction } from "./actions";

export const metadata: Metadata = { title: "Legacy loans" };

const STATUS = { PREVIEWED: "Checked, waiting for the Finance Manager", COMMITTED: "Brought in", REJECTED: "Rejected, nothing imported" } as const;
const when = (d: Date) => d.toLocaleString("en-NG", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short" });
const FILE = "block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-accent/10 file:px-3 file:py-2 file:text-accent";

export default async function LegacyLoansPage({ searchParams }: PageProps<"/staff/legacy-loans">) {
  const user = await requireStaff();
  const canUpload = hasPermission(user.assignments, "legacyImport.upload");
  if (!canUpload && !hasPermission(user.assignments, "legacyImport.commit")) redirect("/forbidden");
  const { error } = await searchParams;
  const db = getDb();
  const [batches, goLive] = await Promise.all([listImportBatches(db, "LEGACY_LOANS"), getDateSetting(db, "go_live_date")]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Legacy loans</h1>
        <p className="text-sm text-muted">
          Loans members already had before Dommus. Each is brought in with what is still owed at go-live and the months left;
          from then on it runs like any other loan. Admin uploads and checks the file; the Finance Manager commits it. No
          history is invented: interest before go-live never appears as revenue.
        </p>
      </div>
      {typeof error === "string" ? <Alert tone="error">{error}</Alert> : null}
      <Alert tone={goLive ? "info" : "error"}>
        {goLive
          ? `Go-live date: ${goLive}. Files must use this date.`
          : "The go-live date isn't set yet. You can check a file now, but it can only be committed once Admin proposes the go-live date in Settings and Management approves it."}
      </Alert>

      {canUpload ? (
        <Card title="Check a file of loans">
          <p className="mb-4 text-sm text-muted">
            MOAUM&apos;s list works as it is: <code>SN, Name, PIN, Department, Tenure, Principal</code>, where PIN is the payroll
            staff number, Tenure the months left and Principal what is still owed. Optional columns:{" "}
            <code>rate_monthly_percent</code> (empty = current rate; 0 = no further interest) and <code>legacy_account_no</code>.
            See the{" "}
            <a className="underline" href="/api/v1/templates/legacy-loans.xlsx">
              template
            </a>
            . Every member must already be in Dommus with that PIN as their payroll staff number.
          </p>
          <form action={previewLegacyAction} className="grid gap-4 sm:grid-cols-2">
            <Field label="Go-live date" hint="The date these balances are as at">
              <Input name="goLive" type="date" required defaultValue={goLive ?? ""} />
            </Field>
            <Field label="Total still owed (₦)" hint="Control total across the file">
              <Input name="controlTotal" required inputMode="decimal" />
            </Field>
            <Field label="Number of loans">
              <Input name="rowCount" required inputMode="numeric" pattern="\d+" />
            </Field>
            <Field label="Loan records (.xlsx or .csv)">
              <input type="file" name="file" required accept=".xlsx,.csv" className={FILE} />
            </Field>
            <div className="sm:col-span-2">
              <Button type="submit">Check (dry run)</Button>
            </div>
          </form>
        </Card>
      ) : null}

      <Card title="Files">
        {batches.length === 0 ? <p className="text-sm text-muted">None yet.</p> : null}
        <ul className="text-sm">
          {batches.map((b) => (
            <li key={b.id} className="flex flex-wrap justify-between gap-2 border-t border-border py-2 first:border-0">
              <Link className="underline" href={`/staff/legacy-loans/${b.id}`}>
                {b.filename}
              </Link>
              <span className="text-muted">
                {b.status === "PREVIEWED" && b.errorRowCount ? "Has errors" : STATUS[b.status]} · {b.rowCount} loan(s) · {when(b.uploadedAt)} by {b.uploadedByName}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
