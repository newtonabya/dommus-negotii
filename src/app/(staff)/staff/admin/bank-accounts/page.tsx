import type { Metadata } from "next";
import { Alert, Button, Card, Field, Input } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { listBankAccounts } from "@/modules/credit/banking/bank-accounts";
import { requireStaffPermission } from "@/shell/auth/session";
import { createBankAccountAction, toggleBankAccountAction } from "./actions";

export const metadata: Metadata = { title: "Bank accounts" };

export default async function BankAccountsPage({ searchParams }: PageProps<"/staff/admin/bank-accounts">) {
  await requireStaffPermission("bankAccounts.manage");
  const { ok, error } = await searchParams;
  const accounts = await listBankAccounts(getDb());

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">MOAUM bank accounts</h1>
        <p className="text-sm text-muted">
          The accounts loans are paid from and repayments are paid into. Every disbursement voucher names one, and the
          ledger records it for bank reconciliation. Accounts are switched off, never deleted.
        </p>
      </div>
      {typeof ok === "string" ? <Alert tone="success">{ok}</Alert> : null}
      {typeof error === "string" ? <Alert tone="error">{error}</Alert> : null}

      <Card title="Add an account">
        <form action={createBankAccountAction} className="grid gap-4 sm:grid-cols-2">
          <Field label="Bank">
            <Input name="bankName" required minLength={2} placeholder="e.g. First Bank" />
          </Field>
          <Field label="Branch (optional)">
            <Input name="branch" placeholder="e.g. Makurdi" />
          </Field>
          <Field label="Account name">
            <Input name="accountName" required minLength={2} placeholder="e.g. MOAUM Credit Super Store" />
          </Field>
          <Field label="Account number" hint="10 digits (NUBAN)">
            <Input name="accountNumber" required inputMode="numeric" pattern="\d{10}" />
          </Field>
          <div className="sm:col-span-2">
            <Button type="submit">Add account</Button>
          </div>
        </form>
      </Card>

      <div className="overflow-x-auto rounded-lg border border-border bg-surface">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead className="border-b border-border text-xs text-muted uppercase">
            <tr>
              <th className="px-4 py-3">Bank</th>
              <th className="px-4 py-3">Account</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {accounts.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-muted">
                  No accounts yet. Add one before the first disbursement.
                </td>
              </tr>
            ) : null}
            {accounts.map((a) => (
              <tr key={a.id} className="border-b border-border last:border-0">
                <td className="px-4 py-3">
                  {a.bankName}
                  {a.branch ? <div className="text-xs text-muted">{a.branch}</div> : null}
                </td>
                <td className="px-4 py-3">
                  <span className="font-mono">{a.accountNumber}</span>
                  <div className="text-xs text-muted">{a.accountName}</div>
                </td>
                <td className="px-4 py-3">{a.active ? "Active" : <span className="text-muted">Off</span>}</td>
                <td className="px-4 py-3 text-right">
                  <form action={toggleBankAccountAction}>
                    <input type="hidden" name="id" value={a.id} />
                    <input type="hidden" name="active" value={String(!a.active)} />
                    <Button type="submit" variant="secondary" className="px-2 py-1 text-xs">
                      {a.active ? "Switch off" : "Switch on"}
                    </Button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
