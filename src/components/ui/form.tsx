import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

/** Minimal shared form primitives (neutral theme; shadcn/ui can replace them later). */

export const inputClass =
  "min-h-12 w-full rounded-xl border-[1.5px] border-border bg-surface px-3.5 py-2.5 text-base outline-none focus:border-accent focus:ring-[3px] focus:ring-accent/20 disabled:cursor-not-allowed disabled:border-dashed disabled:bg-background disabled:text-muted";

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-semibold">{label}</span>
      {children}
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputClass} ${props.className ?? ""}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputClass} ${props.className ?? ""}`} />;
}

type Variant = "primary" | "secondary" | "danger";

const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-foreground hover:opacity-90",
  secondary: "bg-surface text-accent ring-2 ring-inset ring-accent hover:bg-accent/5",
  danger: "bg-danger text-white hover:opacity-90",
};

export function Button({ variant = "primary", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...props}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold transition disabled:cursor-not-allowed disabled:bg-border disabled:text-muted disabled:ring-0 ${variants[variant]} ${props.className ?? ""}`}
    />
  );
}

export function Alert({ tone = "info", children }: { tone?: "info" | "error" | "success"; children: ReactNode }) {
  const tones = {
    info: "bg-accent/10 text-accent",
    error: "bg-danger/10 text-danger",
    success: "bg-success/10 text-success",
  } as const;
  // An icon and the colour together: state is never shown by colour alone.
  const icon = { info: "i", error: "!", success: "✓" } as const;
  return (
    <p role={tone === "error" ? "alert" : "status"} className={`flex items-start gap-2.5 rounded-xl px-3.5 py-3 text-sm font-semibold ${tones[tone]}`}>
      <span aria-hidden="true" className="mt-px inline-grid h-5 w-5 flex-none place-items-center rounded-full border-2 border-current text-[11px] leading-none font-extrabold">
        {icon[tone]}
      </span>
      <span className="whitespace-pre-line">{children}</span>
    </p>
  );
}

export function Card({ title, children, footer }: { title?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="rounded-2xl bg-surface p-5 shadow-[0_1px_2px_rgba(35,31,32,.06),0_4px_16px_rgba(35,31,32,.06)] sm:p-6">
      {title ? <h2 className="mb-4 text-lg font-bold">{title}</h2> : null}
      <div className="flex flex-col gap-4">{children}</div>
      {footer ? <div className="mt-4 border-t border-border pt-4 text-sm text-muted">{footer}</div> : null}
    </section>
  );
}
