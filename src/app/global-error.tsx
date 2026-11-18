"use client";

/**
 * Last resort when even the root layout fails. It replaces the whole document,
 * so it carries its own minimal styles (the global stylesheet isn't loaded).
 */
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  const digest = error instanceof Error && "digest" in error ? String((error as Error & { digest?: string }).digest ?? "") : "";
  return (
    <html lang="en-NG">
      <body style={{ margin: 0, minHeight: "100vh", display: "grid", placeItems: "center", background: "#f5f6f8", color: "#231f20", fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif" }}>
        <title>Something went wrong · MOAUM Credit Super Store</title>
        <main style={{ maxWidth: 420, padding: 24, textAlign: "center" }}>
          <p style={{ fontWeight: 800, letterSpacing: ".05em", textTransform: "uppercase", margin: 0 }}>MOAUM Credit Super Store</p>
          <div aria-hidden="true" style={{ height: 4, width: 128, margin: "8px auto 24px", borderRadius: 2, background: "linear-gradient(90deg,#ed1c24 0 33.3%,#00a650 33.3% 66.6%,#29a8e0 66.6% 100%)" }} />
          <h1 style={{ fontSize: 20, margin: "0 0 8px" }}>Something went wrong</h1>
          <p style={{ fontSize: 14, color: "#5f6368", margin: "0 0 20px" }}>The portal could not be loaded. Try again in a moment.</p>
          <button type="button" onClick={() => retry()} style={{ minHeight: 44, padding: "10px 20px", border: 0, borderRadius: 12, background: "#3d54a4", color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer" }}>
            Try again
          </button>
          {digest ? <p style={{ fontSize: 12, color: "#5f6368", marginTop: 16 }}>Reference: <code>{digest}</code></p> : null}
        </main>
      </body>
    </html>
  );
}
