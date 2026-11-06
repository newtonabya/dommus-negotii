import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Alert, Button, Card, Field, Input, Select } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { formatNaira, kobo } from "@/lib/money";
import { bankOverview, STATEMENT_FIELDS } from "@/modules/credit/banking/statements";
import { requireStaff } from "@/shell/auth/session";
import { hasPermission } from "@/shell/rbac/permissions";
import { commitOpeningAction, importStatementAction, rejectOpeningAction, saveMappingAction, uploadOpeningAction } from "./actions";

export const metadata: Metadata = { title: "Bank" };

const naira = (v: bigint) => formatNaira(kobo(v));
const day = (d: Date) => d.toISOString().slice(0, 10);
const FILE = "block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-accent/10 file:px-3 file:py-2 file:text-accent";
const FIELD_LABEL = {
  transaction_date: "Transaction date",
  value_date: "Value date",
  reference: "Reference",
  narration: "Narration / description",
  debit: "Debit (money out)",
  credit: "Credit (money in)",
  balance: "Running balance",
} as const;

export default async function BankPage({ searchParams }: PageProps<"/staff/bank">) {
  const user = await requireStaff();
  const can = (a: Parameters<typeof hasPermission>[1]) => hasPermission(user.assignments, a);
  if (!can("credit.read") && !can("bankOpening.upload")) redirect("/forbidden");
  const { ok, error } = await searchParams;
  const accounts = await bankOverview(getDb());

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Bank accounts and statements</h1>
        <p className="text-sm text-muted">
          Each MOAUM account starts from its balance at go-live (Admin uploads it, the Finance Manager commits it). Monthly
          statements then follow on from each other: a statement&apos;s opening balance must equal the previous closing
          balance, and lines already imported from an overlapping statement are skipped. Use the{" "}
          <a className="underline" href="/api/v1/templates/bank-statement.xlsx">
            statement template
          </a>
          , or map the bank&apos;s own export once per account.
        </p>
      </div>
      <nav className="flex flex-wrap gap-2 text-sm" aria-label="Bank pages">
        <Link className="rounded-md border border-border px-3 py-1.5 hover:border-accent" href="/staff/bank/matching">
          Matching
        </Link>
        <Link className="rounded-md border border-border px-3 py-1.5 hover:border-accent" href="/staff/bank/cashier">
          Cashier
        </Link>
        <Link className="rounded-md border border-border px-3 py-1.5 hover:border-accent" href="/staff/bank/ageing">
          Ageing report
        </Link>
      </nav>
      {typeof ok === "string" ? <Alert tone="success">{ok}</Alert> : null}
      {typeof error === "string" ? <Alert tone="error">{error}</Alert> : null}
      {accounts.length === 0 ? <p className="text-sm text-muted">No bank accounts yet. Admin adds them under Bank accounts.</p> : null}

      {accounts.map((a) => {
        const last = a.statements[0];
        const nextOpening = last ? last.closingBalance : a.opening?.status === "COMMITTED" ? a.opening.amount : null;
        return (
          <Card key={a.id} title={`${a.bankName} · ${a.accountNumber}${a.active ? "" : " (switched off)"}`}>
            <div className="flex flex-col gap-5">
              <section className="text-sm">
                <h3 className="font-semibold">Go-live opening balance</h3>
                {a.opening ? (
                  <p>
                    {naira(a.opening.amount)} on {day(a.opening.asOf)} ·{" "}
                    <a className="underline" href={`/api/v1/evidence/${a.opening.evidenceId}`} target="_blank" rel="noopener">
                      statement
                    </a>{" "}
                    · {a.opening.status === "COMMITTED" ? <span className="text-success">✓ committed</span> : <span className="text-accent">waiting for the Finance Manager</span>}
                  </p>
                ) : (
                  <p className="text-muted">Not uploaded yet.</p>
                )}
                {a.opening?.status === "PREPARED" && can("bankOpening.commit") && a.opening.uploadedById !== user.id ? (
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    <form action={commitOpeningAction.bind(null, a.opening.id)}>
                      <Button type="submit">Commit</Button>
                    </form>
                    <form action={rejectOpeningAction.bind(null, a.opening.id)} className="flex flex-1 flex-wrap gap-2">
                      <Input name="reason" required minLength={5} placeholder="Why it is rejected" className="min-w-48 flex-1" />
                      <Button type="submit" variant="danger">
                        Reject
                      </Button>
                    </form>
                  </div>
                ) : null}
                {!a.opening && can("bankOpening.upload") ? (
                  <form action={uploadOpeningAction} className="mt-2 grid gap-3 sm:grid-cols-3">
                    <input type="hidden" name="accountId" value={a.id} />
                    <Field label="Balance date" hint="The go-live date">
                      <Input name="asOf" type="date" required />
                    </Field>
                    <Field label="Balance (₦)">
                      <Input name="amount" required inputMode="decimal" />
                    </Field>
                    <Field label="Statement showing it">
                      <input type="file" name="evidence" required accept=".pdf,.jpg,.jpeg,.png,.xlsx,.csv" className={FILE} />
                    </Field>
                    <div className="sm:col-span-3">
                      <Button type="submit">Save opening balance</Button>
                    </div>
                  </form>
                ) : null}
              </section>

              {can("bankStatement.upload") ? (
                <details className="text-sm">
                  <summary className="cursor-pointer font-semibold">Column mapping for this bank&apos;s export</summary>
                  <form action={saveMappingAction.bind(null, a.id)} className="mt-3 grid gap-3 sm:grid-cols-2">
                    {STATEMENT_FIELDS.map((f) => (
                      <Field key={f} label={FIELD_LABEL[f]} hint={`Leave empty for the template's "${f}"`}>
                        <Input name={f} defaultValue={a.mapping?.fields[f] ?? ""} />
                      </Field>
                    ))}
                    <Field label="Date format">
                      <Select name="dateFormat" defaultValue={a.mapping?.dateFormat ?? "ISO"}>
                        <option value="ISO">2026-01-31</option>
                        <option value="DMY">31/01/2026 (day first)</option>
                        <option value="MDY">01/31/2026 (month first)</option>
                      </Select>
                    </Field>
                    <div className="sm:col-span-2">
                      <Button type="submit" variant="secondary">
                        Save mapping
                      </Button>
                    </div>
                  </form>
                </details>
              ) : null}

              {can("bankStatement.upload") && nextOpening !== null ? (
                <section className="text-sm">
                  <h3 className="font-semibold">Import a statement</h3>
                  <form action={importStatementAction.bind(null, a.id)} className="mt-2 grid gap-3 sm:grid-cols-2">
                    <Field label="From">
                      <Input name="from" type="date" required />
                    </Field>
                    <Field label="To">
                      <Input name="to" type="date" required />
                    </Field>
                    <Field label="Opening balance (₦)" hint={`Should continue ${naira(nextOpening)}`}>
                      <Input name="opening" required inputMode="decimal" />
                    </Field>
                    <Field label="Closing balance (₦)">
                      <Input name="closing" required inputMode="decimal" />
                    </Field>
                    <Field label="Statement file (.xlsx or .csv)">
                      <input type="file" name="file" required accept=".xlsx,.csv" className={FILE} />
                    </Field>
                    <div className="sm:col-span-2">
                      <Button type="submit">Import statement</Button>
                    </div>
                  </form>
                </section>
              ) : null}

              <section className="text-sm">
                <h3 className="font-semibold">Statements</h3>
                {a.statements.length === 0 ? (
                  <p className="text-muted">None imported yet.</p>
                ) : (
                  <ul className="tabular-nums">
                    {a.statements.map((s) => (
                      <li key={s.id} className="border-t border-border py-2 first:border-0">
                        {day(s.periodFrom)} to {day(s.periodTo)} · {naira(s.openingBalance)} → {naira(s.closingBalance)} · {s.lineCount} line(s)
                        {s.skippedCount ? `, ${s.skippedCount} skipped` : ""} ·{" "}
                        <a className="underline" href={`/api/v1/evidence/${s.evidenceId}`} target="_blank" rel="noopener">
                          file
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
