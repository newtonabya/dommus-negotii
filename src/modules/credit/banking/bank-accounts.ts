import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { writeAudit } from "@/shell/audit/audit";
import { MemberError, type MemberActor } from "../members/invitations";

/** MOAUM bank accounts money is paid from or into (PRD F10; configured by Admin). */
export const bankAccountSchema = z.object({
  bankName: z.string().trim().min(2, "Enter the bank's name.").max(80),
  branch: z.string().trim().max(80).transform((v) => v || null),
  accountName: z.string().trim().min(2, "Enter the account name.").max(120),
  accountNumber: z.string().trim().regex(/^\d{10}$/, "Enter the 10-digit account number (NUBAN)."),
});

export async function listBankAccounts(db: Db, activeOnly = false) {
  return db.bankAccount.findMany({ where: activeOnly ? { active: true } : {}, orderBy: [{ active: "desc" }, { bankName: "asc" }] });
}

export async function createBankAccount(db: Db, actor: MemberActor, input: z.input<typeof bankAccountSchema>) {
  const parsed = bankAccountSchema.safeParse(input);
  if (!parsed.success) throw new MemberError(parsed.error.issues[0]?.message ?? "Check the form.");
  try {
    const account = await db.bankAccount.create({ data: { ...parsed.data, createdById: actor.id } });
    await writeAudit(db, { action: "bank_account.create", entityType: "BankAccount", entityId: account.id, userId: actor.id, ipAddress: actor.ipAddress, after: parsed.data });
    return account;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new MemberError("That account number is already listed.");
    throw error;
  }
}

/** Accounts are switched off, never deleted: vouchers and ledger events refer to them. */
export async function setBankAccountActive(db: Db, actor: MemberActor, id: string, active: boolean) {
  await db.bankAccount.update({ where: { id }, data: { active } });
  await writeAudit(db, { action: active ? "bank_account.activate" : "bank_account.deactivate", entityType: "BankAccount", entityId: id, userId: actor.id, ipAddress: actor.ipAddress });
}
