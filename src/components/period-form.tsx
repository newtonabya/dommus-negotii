"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { Button, Field, Input } from "@/components/ui/form";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const nice = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/**
 * The reports period. Apply moves to the same page with ?from=&to= without a
 * full reload, shows that it is working, and the period in force is stated
 * plainly. It is still a GET form, so it works without JavaScript too.
 * Give it key={`${from}|${to}`} so it starts afresh when the period changes.
 */
export function PeriodForm({ from, to, today, basePath }: { from: string; to: string; today: string; basePath: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [f, setF] = useState(from);
  const [t, setT] = useState(to);
  const [error, setError] = useState("");

  const go = (a: string, b: string) => {
    if (!ISO.test(a) || !ISO.test(b)) {
      setError("Enter both dates.");
      return;
    }
    const [x, y] = a <= b ? [a, b] : [b, a];
    setError("");
    setF(x);
    setT(y);
    startTransition(() => router.push(`${basePath}?from=${x}&to=${y}` as never));
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    go(f, t);
  };

  const [yy, mm] = today.split("-").map(Number) as [number, number];
  const prev = mm === 1 ? { y: yy - 1, m: 12 } : { y: yy, m: mm - 1 };
  const presets = [
    { label: "This month", a: `${yy}-${pad(mm)}-01`, b: today },
    { label: "Last month", a: `${prev.y}-${pad(prev.m)}-01`, b: `${prev.y}-${pad(prev.m)}-${pad(lastDay(prev.y, prev.m))}` },
    { label: "This year", a: `${yy}-01-01`, b: today },
  ];
  const changed = f !== from || t !== to;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        Showing <strong>{nice(from)}</strong> to <strong>{nice(to)}</strong>
        {pending ? <span className="ml-2 text-accent">· updating…</span> : null}
      </p>
      <form method="get" action={basePath} onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <Field label="From">
          <Input type="date" name="from" value={f} max={today} onChange={(e) => setF(e.target.value)} required />
        </Field>
        <Field label="To">
          <Input type="date" name="to" value={t} max={today} onChange={(e) => setT(e.target.value)} required />
        </Field>
        <Button type="submit" variant={changed ? "primary" : "secondary"} disabled={pending} aria-busy={pending}>
          {pending ? "Applying…" : "Apply"}
        </Button>
      </form>
      <div className="flex flex-wrap gap-2 text-sm">
        {presets.map((p) => (
          <button
            key={p.label}
            type="button"
            disabled={pending}
            onClick={() => go(p.a, p.b)}
            className={`rounded-full border px-3 py-1 ${p.a === from && p.b === to ? "border-accent bg-accent/10 font-semibold text-accent" : "border-border hover:border-accent"}`}
          >
            {p.label}
          </button>
        ))}
      </div>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </div>
  );
}
