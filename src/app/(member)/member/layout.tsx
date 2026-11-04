import Link from "next/link";
import { BrandMark } from "@/components/brand";
import { MemberTabs, NavLink } from "@/components/nav";
import { SessionActivity } from "@/components/session-activity";
import { SignOutButton } from "@/components/sign-out-button";
import { requireUser } from "@/shell/auth/session";
import { MEMBER_IDLE_MINUTES } from "@/shell/auth/security";

export const dynamic = "force-dynamic";

export default async function MemberLayout({ children }: LayoutProps<"/member">) {
  const user = await requireUser();
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-3xl items-center gap-4 px-4 py-2">
          <Link href="/member" className="rounded-lg">
            <BrandMark subtitle={user.name} />
          </Link>
          <nav aria-label="Main" className="ml-4 hidden gap-4 sm:flex">
            <NavLink href="/member" label="Home" exact />
            <NavLink href="/member/loans" label="Loans" />
            <NavLink href="/member/profile" label="My details" />
          </nav>
          <div className="ml-auto text-sm">
            <SignOutButton />
          </div>
        </div>
        <div className="brand-rule rounded-none" aria-hidden="true" />
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pt-6 pb-28 sm:pb-10">{children}</main>
      <MemberTabs />
      <SessionActivity idleMinutes={MEMBER_IDLE_MINUTES} />
    </div>
  );
}
