"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

function isActive(pathname: string, href: string, exact: boolean) {
  return exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

/** A navigation link that shows where you are: colour, weight and an underline bar. */
export function NavLink({ href, label, exact = false }: { href: string; label: string; exact?: boolean }) {
  const pathname = usePathname();
  const active = isActive(pathname, href, exact);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`relative inline-flex min-h-11 items-center px-1 text-sm whitespace-nowrap ${
        active ? "font-bold text-accent after:absolute after:inset-x-1 after:bottom-0 after:h-[3px] after:rounded-full after:bg-accent" : "font-medium text-muted hover:text-foreground"
      }`}
    >
      {label}
    </Link>
  );
}

const icons = {
  home: "M3 11l9-7 9 7M5 10v10h14V10",
  loans: "M3 6h18v14H3zM3 10h18",
  profile: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c1.5-4 4.5-6 8-6s6.5 2 8 6",
} as const;

/** Member bottom tab bar on phones: three labelled destinations. */
export function MemberTabs() {
  const pathname = usePathname();
  const tabs = [
    { href: "/member", label: "Home", icon: icons.home, exact: true },
    { href: "/member/loans", label: "Loans", icon: icons.loans, exact: false },
    { href: "/member/profile", label: "My details", icon: icons.profile, exact: false },
  ];
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-3 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] sm:hidden">
      {tabs.map((t) => {
        const active = isActive(pathname, t.href, t.exact);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={`flex min-h-16 flex-col items-center justify-center gap-1 text-xs ${active ? "font-bold text-accent" : "font-medium text-muted"}`}
          >
            <span aria-hidden="true" className={`h-[3px] w-7 rounded-full ${active ? "bg-accent" : "bg-transparent"}`} />
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={t.icon} />
            </svg>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
