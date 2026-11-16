"use client";

import { useState } from "react";
import { Field, Input } from "@/components/ui/form";
import { AccountCheck } from "./account-check";
import { BANKS } from "./application-form";

/**
 * Bank and account number inputs for a plain form (field names
 * `beneficiaryBank` and `beneficiaryAccountNo`), with the bank suggestions and
 * the live account-number check used on loan applications.
 */
export function BankAccountFields({ id }: { id: string }) {
  const [bank, setBank] = useState("");
  const [accountNo, setAccountNo] = useState("");
  return (
    <>
      <Field label="Bank">
        <Input name="beneficiaryBank" required minLength={2} placeholder="e.g. First Bank" list={`${id}-banks`} autoComplete="off" value={bank} onChange={(e) => setBank(e.target.value)} />
        <datalist id={`${id}-banks`}>
          {BANKS.map((b) => (
            <option key={b} value={b} />
          ))}
        </datalist>
      </Field>
      <Field label="Account number" hint="10 digits (NUBAN)">
        <Input name="beneficiaryAccountNo" required inputMode="numeric" pattern="\d{10}" maxLength={10} value={accountNo} onChange={(e) => setAccountNo(e.target.value)} />
        <AccountCheck bank={bank} accountNo={accountNo} />
      </Field>
    </>
  );
}
