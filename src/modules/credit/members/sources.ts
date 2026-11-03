import { z } from "zod";
import type { Db } from "@/lib/db";
import { writeAudit } from "@/shell/audit/audit";
import { MemberError, type MemberActor } from "./invitations";

export const sourceSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_-]{2,20}$/, "Use 2–20 letters, digits, dashes or underscores, e.g. PAYROLL-A."),
  name: z.string().trim().min(3, "Give the source a name.").max(100),
});

/** Admin adds a remittance source (PRD F9: sources are configured by Admin). */
export async function createSource(db: Db, actor: MemberActor, input: z.input<typeof sourceSchema>) {
  const data = sourceSchema.parse(input);
  if (await db.remittanceSource.findUnique({ where: { code: data.code } })) {
    throw new MemberError(`A source with code ${data.code} already exists.`);
  }
  const source = await db.remittanceSource.create({ data: { ...data, createdById: actor.id } });
  await writeAudit(db, {
    action: "remittance_source.create",
    entityType: "RemittanceSource",
    entityId: source.id,
    userId: actor.id,
    ipAddress: actor.ipAddress,
    after: data,
  });
  return source;
}

/** Sources are never deleted (schedules and members refer to them); they're switched off. */
export async function setSourceActive(db: Db, actor: MemberActor, id: string, active: boolean) {
  const source = await db.remittanceSource.update({ where: { id }, data: { active } });
  await writeAudit(db, {
    action: active ? "remittance_source.activate" : "remittance_source.deactivate",
    entityType: "RemittanceSource",
    entityId: id,
    userId: actor.id,
    ipAddress: actor.ipAddress,
  });
  return source;
}

export function listSources(db: Db, onlyActive = false) {
  return db.remittanceSource.findMany({ where: onlyActive ? { active: true } : {}, orderBy: { name: "asc" } });
}
