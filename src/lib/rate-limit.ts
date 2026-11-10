import type { Db } from "@/lib/db";

/**
 * A small fixed-window limiter kept in memory. Good enough to slow down
 * guessing on a public page; each server instance counts separately.
 */
const windows = new Map<string, { start: number; count: number }>();

export function allow(key: string, max: number, windowMs: number, now = Date.now()): boolean {
  const w = windows.get(key);
  if (!w || now - w.start >= windowMs) {
    windows.set(key, { start: now, count: 1 });
    if (windows.size > 10_000) {
      for (const [k, v] of windows) if (now - v.start >= windowMs) windows.delete(k);
    }
    return true;
  }
  w.count++;
  return w.count <= max;
}

/**
 * The same fixed window, counted in the database so every server instance
 * shares it (shell.rate_limit; `last_request` holds the window's start). If
 * the database can't be reached it falls back to this instance's own count.
 */
export async function allowShared(db: Db, key: string, max: number, windowMs: number, now = Date.now()): Promise<boolean> {
  try {
    const cutoff = BigInt(now - windowMs);
    const rows = await db.$queryRaw<Array<{ count: number }>>`
      INSERT INTO "shell"."rate_limit" ("id", "key", "count", "last_request")
      VALUES (gen_random_uuid()::text, ${`app:${key}`}, 1, ${BigInt(now)})
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE WHEN "rate_limit"."last_request" <= ${cutoff} THEN 1 ELSE "rate_limit"."count" + 1 END,
        "last_request" = CASE WHEN "rate_limit"."last_request" <= ${cutoff} THEN ${BigInt(now)} ELSE "rate_limit"."last_request" END
      RETURNING "count"`;
    return (rows[0]?.count ?? 1) <= max;
  } catch {
    return allow(key, max, windowMs, now);
  }
}
