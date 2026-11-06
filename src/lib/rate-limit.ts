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
