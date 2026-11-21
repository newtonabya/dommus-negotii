import type { ReactNode } from "react";
import { Logo } from "@/components/brand";
import { buttonClass } from "@/components/ui/form";

/**
 * A full-page message in the portal's own look (logo, name, brand rule, card):
 * page not found, something went wrong, not available to you.
 */
export function StatusScreen({ code, title, children, actions }: { code?: string; title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <Logo size={96} />
          <p className="text-base font-extrabold tracking-wide uppercase">MOAUM Credit Super Store</p>
          <div className="brand-rule w-32" aria-hidden="true" />
        </div>
        <section className="rounded-2xl bg-surface p-6 text-center shadow-[0_1px_2px_rgba(35,31,32,.06),0_4px_16px_rgba(35,31,32,.06)]">
          {code ? <p className="text-xs font-bold tracking-widest text-muted uppercase">{code}</p> : null}
          <h1 className="mt-1 text-xl font-bold">{title}</h1>
          <div className="mt-2 text-sm text-muted">{children}</div>
          {actions ? <div className="mt-5 flex flex-wrap items-center justify-center gap-3">{actions}</div> : null}
        </section>
      </div>
    </main>
  );
}

export const primaryLinkClass = buttonClass("primary");
export const secondaryLinkClass = buttonClass("secondary");
