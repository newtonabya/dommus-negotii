"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Logo } from "@/components/brand";
import { Icon, type IconName } from "@/components/icons";
import { SignOutButton } from "@/components/sign-out-button";

export type NavItem = { href: string; label: string; icon: IconName; exact?: boolean; badge?: number };
export type NavGroup = { title: string | null; items: NavItem[] };
export type ShellUser = { name: string; detail: string; accountHref: string };

/** The deepest menu item containing the current page: "/staff/members/invitations" lights Invitations, not Members. */
function findActive(pathname: string, groups: NavGroup[]): { item: NavItem; group: NavGroup } | null {
  let best: { item: NavItem; group: NavGroup } | null = null;
  for (const group of groups) {
    for (const item of group.items) {
      const hit = item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
      if (hit && (!best || item.href.length > best.item.href.length)) best = { item, group };
    }
  }
  return best;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "")).toUpperCase();
}

/** Logo on a white tile (the logo has a white ground), the product name and the area. */
function SidebarBrand({ area, href }: { area: string; href: string }) {
  return (
    <Link href={href} className="flex items-center gap-3 rounded-lg px-1 py-1 outline-offset-4">
      <span className="grid h-11 w-11 flex-none place-items-center rounded-xl bg-white p-1">
        <Logo size={34} priority />
      </span>
      <span className="min-w-0 leading-tight">
        <span className="block text-[13px] font-extrabold tracking-wide text-white uppercase">MOAUM Credit</span>
        <span className="block text-[13px] font-extrabold tracking-wide text-white uppercase">Super Store</span>
        <span className="mt-0.5 block text-xs font-medium text-sidebar-muted">{area}</span>
      </span>
    </Link>
  );
}

function Menu({ groups, activeHref, onPick }: { groups: NavGroup[]; activeHref: string | null; onPick?: () => void }) {
  return (
    <div className="flex flex-col gap-5">
      {groups.map((g, i) => (
        <div key={g.title ?? `g${i}`}>
          {g.title ? <p className="mb-1.5 px-3 text-[11px] font-bold tracking-[0.08em] text-sidebar-muted uppercase">{g.title}</p> : null}
          <ul className="flex flex-col gap-0.5">
            {g.items.map((item) => {
              const on = item.href === activeHref;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onPick}
                    aria-current={on ? "page" : undefined}
                    className={`group relative flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm transition-colors ${
                      on ? "bg-accent-strong font-semibold text-white" : "font-medium text-sidebar-fg hover:bg-white/[0.07] hover:text-white"
                    }`}
                  >
                    <Icon name={item.icon} className={`h-[18px] w-[18px] flex-none ${on ? "text-white" : "text-sidebar-muted group-hover:text-white"}`} />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.badge ? (
                      <span className="min-w-5 rounded-full bg-attention px-1.5 py-px text-center text-[11px] leading-[18px] font-bold text-white tabular-nums">
                        <span className="sr-only">, </span>
                        {item.badge > 99 ? "99+" : item.badge}
                        <span className="sr-only"> waiting</span>
                      </span>
                    ) : null}
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

function UserCard({ user }: { user: ShellUser }) {
  return (
    <div className="flex items-center gap-3 border-t border-white/10 px-4 py-3">
      <Link href={user.accountHref} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg py-1 hover:text-white" title="Your account">
        <span aria-hidden="true" className="grid h-9 w-9 flex-none place-items-center rounded-full bg-accent-strong text-xs font-bold text-white">
          {initials(user.name)}
        </span>
        <span className="min-w-0 leading-tight">
          <span className="block truncate text-sm font-semibold text-white">{user.name}</span>
          <span className="block truncate text-xs text-sidebar-muted">{user.detail}</span>
        </span>
      </Link>
      <SignOutButton variant="sidebar" />
    </div>
  );
}

/** The three-colour rule from the letterhead, as a vertical edge. */
function BrandEdge() {
  return (
    <span aria-hidden="true" className="absolute inset-y-0 right-0 flex w-[3px] flex-col">
      <span className="flex-1 bg-brand-red" />
      <span className="flex-1 bg-brand-green" />
      <span className="flex-1 bg-brand-sky" />
    </span>
  );
}

/**
 * The portal frame: a full-height ink sidebar on computers; on phones and
 * tablets a slim ink top bar whose menu button slides the same sidebar in.
 * `phoneMenu={false}` (members) leaves the phone menu to the bottom tabs.
 */
export function AppShell({
  area,
  homeHref,
  groups,
  user,
  banners,
  phoneMenu = true,
  narrow = false,
  children,
}: {
  area: string;
  homeHref: string;
  groups: NavGroup[];
  user: ShellUser;
  banners?: ReactNode;
  phoneMenu?: boolean;
  /** A narrower reading column (members). */
  narrow?: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const active = findActive(pathname, groups);
  // Open only on the page it was opened on, so going to another page closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpenOn(null);
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  // Where you are: section, page and, below a page, "Details". The section is left out when it repeats the page name.
  const section = active?.group.title && active.group.title !== active.item.label ? active.group.title : null;
  const deeper = active !== null && pathname !== active.item.href;

  return (
    <div className="flex flex-1">
      {/* Computers: the sidebar. */}
      <aside className="sticky top-0 hidden h-dvh w-64 flex-none flex-col bg-sidebar lg:flex print:hidden">
        <BrandEdge />
        <div className="px-4 pt-5 pb-4">
          <SidebarBrand area={area} href={homeHref} />
        </div>
        <nav aria-label="Main" className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 [scrollbar-color:rgba(255,255,255,.2)_transparent] [scrollbar-width:thin]">
          <Menu groups={groups} activeHref={active?.item.href ?? null} />
        </nav>
        <UserCard user={user} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Phones and tablets: the top bar. */}
        <header className="sticky top-0 z-20 bg-sidebar lg:hidden print:hidden">
          <div className="flex items-center gap-2 px-3 py-2">
            {phoneMenu ? (
              <button
                type="button"
                aria-expanded={open}
                aria-controls="phone-menu"
                aria-label="Open the menu"
                onClick={() => setOpenOn(pathname)}
                className="grid h-11 w-11 place-items-center rounded-xl text-white hover:bg-white/10"
              >
                <Icon name="menu" className="h-6 w-6" />
              </button>
            ) : null}
            <Link href={homeHref} className="flex min-w-0 items-center gap-2.5 rounded-lg py-1">
              <span className="grid h-9 w-9 flex-none place-items-center rounded-lg bg-white p-0.5">
                <Logo size={28} priority />
              </span>
              <span className="min-w-0 leading-tight">
                <span className="block truncate text-[13px] font-extrabold tracking-wide text-white uppercase">
                  MOAUM <span className="hidden min-[380px]:inline">Credit </span>Super Store
                </span>
                <span className="block truncate text-xs text-sidebar-muted">{phoneMenu ? area : user.name}</span>
              </span>
            </Link>
            <div className="ml-auto">
              <SignOutButton variant="sidebar" />
            </div>
          </div>
          <div aria-hidden="true" className="flex h-[3px]">
            <span className="flex-1 bg-brand-red" />
            <span className="flex-1 bg-brand-green" />
            <span className="flex-1 bg-brand-sky" />
          </div>
        </header>

        {phoneMenu && open ? (
          <div className="lg:hidden">
            <div className="fixed inset-0 z-30 bg-black/50" aria-hidden="true" onClick={() => setOpenOn(null)} />
            <div id="phone-menu" role="dialog" aria-modal="true" aria-label="Menu" className="fixed inset-y-0 left-0 z-40 flex w-72 max-w-[85vw] flex-col bg-sidebar shadow-2xl">
              <BrandEdge />
              <div className="flex items-start justify-between gap-2 px-4 pt-4 pb-3">
                <SidebarBrand area={area} href={homeHref} />
                <button type="button" aria-label="Close the menu" onClick={() => setOpenOn(null)} className="grid h-10 w-10 flex-none place-items-center rounded-xl text-white hover:bg-white/10">
                  <Icon name="close" className="h-5 w-5" />
                </button>
              </div>
              <nav aria-label="Main" className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
                <Menu groups={groups} activeHref={active?.item.href ?? null} onPick={() => setOpenOn(null)} />
              </nav>
              <UserCard user={user} />
            </div>
          </div>
        ) : null}

        {banners}

        <div className={`mx-auto w-full flex-1 px-4 pt-5 sm:px-6 lg:px-10 lg:pt-8 ${narrow ? "max-w-3xl" : "max-w-6xl"} ${phoneMenu ? "pb-10" : "pb-28 lg:pb-10"}`}>
          {active && (section || deeper) ? (
            <nav aria-label="You are here" className="mb-3 flex flex-wrap items-center gap-1.5 text-xs font-semibold text-muted print:hidden">
              {section ? (
                <>
                  <span>{section}</span>
                  <Icon name="chevronRight" className="h-3.5 w-3.5" />
                </>
              ) : null}
              {deeper ? (
                <>
                  <Link href={active.item.href} className="hover:text-accent hover:underline">
                    {active.item.label}
                  </Link>
                  <Icon name="chevronRight" className="h-3.5 w-3.5" />
                  <span className="text-foreground">Details</span>
                </>
              ) : (
                <span className="text-foreground">{active.item.label}</span>
              )}
            </nav>
          ) : null}
          <main id="content">{children}</main>
        </div>
      </div>
    </div>
  );
}
