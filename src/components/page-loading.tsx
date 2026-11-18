/** Shown while a page's data loads: the shape of a heading and two cards, so the screen doesn't jump. */
export function PageLoading() {
  return (
    <div role="status" aria-live="polite" className="flex animate-pulse flex-col gap-4">
      <span className="sr-only">Loading…</span>
      <div className="h-8 w-56 rounded-lg bg-border" />
      <div className="h-4 w-80 max-w-full rounded bg-border/70" />
      <div className="mt-2 h-40 rounded-2xl bg-surface shadow-[0_1px_2px_rgba(35,31,32,.06)]" />
      <div className="h-64 rounded-2xl bg-surface shadow-[0_1px_2px_rgba(35,31,32,.06)]" />
    </div>
  );
}
