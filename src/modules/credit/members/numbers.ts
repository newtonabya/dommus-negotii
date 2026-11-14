import type { Db } from "@/lib/db";

/**
 * Takes the next MOAUM numbers (MOAUM/0001 onwards) for members about to be
 * created. A number, once taken, is never reused, even if the transaction
 * rolls back: gaps are possible, duplicates are not.
 */
export async function issueMemberNos(db: Db, count: number): Promise<string[]> {
  if (count <= 0) return [];
  const rows = await db.$queryRaw<Array<{ no: string }>>`SELECT "credit"."next_member_no"() AS no FROM generate_series(1, ${count}::int)`;
  return rows.map((r) => r.no);
}

export async function issueMemberNo(db: Db): Promise<string> {
  return (await issueMemberNos(db, 1))[0] as string;
}
