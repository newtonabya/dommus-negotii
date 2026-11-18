"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

export type NavItem = { href: string; label: string; exact?: boolean };
export type NavGroup = { title: string | null; items: NavItem[] };

/** The deepest item that contains the current page wins, so "/staff/members/invitations" lights Invitations, not Members. */
function activeHref(pathname: string, groups: NavGroup[]): string | null {
  let best: string | null = null;
  for (const item of groups.flatMap((g) => g.items)) {
    const hit = item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
    if (hit && (!best || item.href.length > best.length)) best = item.href;
  }
  return best;
}

function Groups({ groups, active, onPick }: { groups: NavGroup[]; active: string | null; onPick?: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      {groups.map((g, i) => (
        <div key={g.title ?? i}>
          {g.title ? <p className="mb-1.5 px-3 text-[11px] font-bold tracking-wider text-muted uppercase">{g.title}</p> : null}
          <ul className="flex flex-col gap-0.5">
            {g.items.map((item) => {
              const on = item.href === active;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onPick}
                    aria-current={on ? "page" : undefined}
                    className={`flex min-h-9 items-center rounded-lg px-3 text-sm ${
                      on ? "bg-accent/10 font-bold text-accent" : "font-medium text-foreground/80 hover:bg-background hover:text-foreground"
                    }`}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Desktop: a sticky sidebar. */
export function StaffSidebar({ groups }: { groups: NavGroup[] }) {
  const active = activeHref(usePathname(), groups);
  return (
    <nav aria-label="Main" className="sticky top-24 hidden max-h-[calc(100vh-7rem)] self-start w-56 flex-none overflow-y-auto pb-6 lg:block">
      <Groups groups={groups} active={active} />
    </nav>
  );
}

/** Phones and tablets: a Menu button that opens the same groups as a panel, closed again on navigation. */
export function StaffMenuButton({ groups }: { groups: NavGroup[] }) {
  const pathname = usePathname();
  const active = activeHref(pathname, groups);
  // Open only on the page it was opened on, so moving to another page closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  const setOpen = (next: boolean | ((o: boolean) => boolean)) =>
    setOpenOn((typeof next === "function" ? next(open) : next) ? pathname : null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpenOn(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  const current = groups.flatMap((g) => g.items).find((i) => i.href === active)?.label;
  return (
    <div className="lg:hidden">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="staff-menu"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-xl px-2.5 text-sm font-bold sm:px-3 text-accent ring-2 ring-accent/30 ring-inset hover:bg-accent/5"
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
          {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
        </svg>
        <span className="sr-only sm:not-sr-only">Menu</span>
        {current && !open ? <span className="hidden max-w-[10rem] truncate font-semibold text-muted sm:inline">· {current}</span> : null}
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-30 bg-foreground/30" aria-hidden="true" onClick={() => setOpen(false)} />
          <nav
            id="staff-menu"
            aria-label="Main"
            className="fixed inset-y-0 left-0 z-40 w-72 max-w-[85vw] overflow-y-auto bg-surface px-3 pt-5 pb-10 shadow-xl"
          >
            <Groups groups={groups} active={active} onPick={() => setOpen(false)} />
          </nav>
        </>
      ) : null}
    </div>
  );
}
