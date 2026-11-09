import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Alert, Button, Card } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { formatNaira, kobo } from "@/lib/money";
import { loadLegacyBatch } from "@/modules/credit/loans/legacy-import";
import { requireStaff } from "@/shell/auth/session";
import { hasPermission } from "@/shell/rbac/permissions";
import { getDateSetting } from "@/shell/settings/settings";
import { commitLegacyAction } from "../actions";

export const metadata: Metadata = { title: "Legacy loans: dry run" };

const naira = (v: string | bigint) => formatNaira(kobo(BigInt(v)));

export default async function LegacyBatchPage({ params, searchParams }: PageProps<"/staff/legacy-loans/[id]">) {
  const user = await requireStaff();
  const canCommit = hasPermission(user.assignments, "legacyImport.commit");
  if (!canCommit && !hasPermission(user.assignments, "legacyImport.upload")) redirect("/forbidden");
  const { id } = await params;
  const { ok, error } = await searchParams;
  const db = getDb();
  const [loaded, goLive] = await Promise.all([loadLegacyBatch(db, id), getDateSetting(db, "go_live_date")]);
  if (!loaded) notFound();
  const { batch, stored, rows } = loaded;
  const errorRows = rows.filter((r) => r.errors.length > 0).length;
  const clean = stored.batchErrors.length === 0 && errorRows === 0;
  const loanNos = batch.status === "COMMITTED" ? await db.loan.findMany({ where: { id: { in: rows.flatMap((r) => (r.loanId ? [r.loanId] : [])) } }, select: { id: true, loanAccountNo: true, legacyAccountNo: true } }) : [];
  const commitBlock =
    batch.status !== "PREVIEWED"
      ? null
      : !clean
        ? "Fix the file and check it again: nothing can be committed while any row has an error."
        : batch.uploadedById === user.id
          ? "Someone other than you, the uploader, must commit it (the Finance Manager)."
          : !goLive
            ? "The go-live date isn't set yet: Admin proposes it in Settings, Management approves it."
            : goLive !== stored.goLiveDate
              ? `The file is for ${stored.goLiveDate} but the go-live date is ${goLive}.`
              : null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/staff/legacy-loans" className="text-sm underline">
          ← Legacy loans
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">{batch.filename}</h1>
        <p className="text-sm text-muted">
          Go-live {stored.goLiveDate} · {rows.length} loan(s) · {naira(stored.total)} still owed (control total {naira(stored.controlTotal)}) ·{" "}
          <a className="underline" href={`/api/v1/evidence/${batch.evidenceId}`} target="_blank" rel="noopener">
            file
          </a>
        </p>
      </div>
      {typeof ok === "string" ? <Alert tone="success">{ok}</Alert> : null}
      {typeof error === "string" ? <Alert tone="error">{error}</Alert> : null}
      {batch.status === "REJECTED" ? <Alert tone="error">Rejected at commit; nothing was imported. Fix the file and check it again.</Alert> : null}
      {stored.batchErrors.length ? (
        <Card title="Problems with the file">
          <ul className="list-disc pl-5 text-sm text-danger">
            {stored.batchErrors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card title="Loans">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm tabular-nums">
            <thead className="text-xs text-muted uppercase">
              <tr>
                <th className="py-1 pr-3">Row</th>
                <th className="py-1 pr-3">PIN · member</th>
                <th className="py-1 pr-3 text-right">Still owed</th>
                <th className="py-1 pr-3 text-right">Months left</th>
                <th className="py-1 pr-3 text-right">Rate</th>
                <th className="py-1 pr-3 text-right">First instalment</th>
                <th className="py-1">Checks</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const loan = loanNos.find((l) => l.id === r.loanId);
                return (
                  <tr key={r.rowNo} className="border-t border-border align-top">
                    <td className="py-1 pr-3">{r.rowNo}</td>
                    <td className="py-1 pr-3">
                      <span className="font-mono">{r.plan?.pin || r.raw.pin}</span> · {r.plan?.memberName || r.raw.name}
                      {r.plan?.memberNo ? <span className="block text-xs text-muted">{r.plan.memberNo}</span> : null}
                      {loan ? (
                        <Link className="block font-mono text-xs underline" href={`/staff/loans/${loan.id}`}>
                          {loan.loanAccountNo} (was {loan.legacyAccountNo})
                        </Link>
                      ) : null}
                    </td>
                    <td className="py-1 pr-3 text-right">{r.plan ? naira(r.plan.outstanding) : r.raw.principal}</td>
                    <td className="py-1 pr-3 text-right">{r.plan?.tenure ?? r.raw.tenure}</td>
                    <td className="py-1 pr-3 text-right">{r.plan ? `${r.plan.rateBps / 100}%` : ""}</td>
                    <td className="py-1 pr-3 text-right">{r.plan && r.plan.firstDueDate ? `${naira(r.plan.firstInstallment)} on ${r.plan.firstDueDate}` : "—"}</td>
                    <td className="py-1">
                      {r.errors.map((e) => (
                        <div key={e} className="text-danger">
                          ✗ {e}
                        </div>
                      ))}
                      {r.plan?.warnings.map((w) => (
                        <div key={w} className="text-warning">
                          ! {w}
                        </div>
                      ))}
                      {r.errors.length === 0 && !r.plan?.warnings.length ? <span className="text-success">✓</span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {batch.status === "PREVIEWED" && canCommit ? (
        <Card title="Commit">
          {commitBlock ? (
            <p className="text-sm text-muted">{commitBlock}</p>
          ) : (
            <>
              <p className="mb-3 text-sm text-muted">
                Every check runs again. Each loan gets a new loan number (its old one kept beside it), starts on {stored.goLiveDate} and gets one opening balance.
                Read the warnings first: a name that differs may be a different person.
              </p>
              <form action={commitLegacyAction.bind(null, batch.id)}>
                <Button type="submit">Bring in {rows.length} loan(s)</Button>
              </form>
            </>
          )}
        </Card>
      ) : null}
    </div>
  );
}
