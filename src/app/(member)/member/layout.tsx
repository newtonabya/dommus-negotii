import { AppShell, type NavGroup } from "@/components/app-shell";
import { MemberTabs } from "@/components/nav";
import { SessionActivity } from "@/components/session-activity";
import { getDb } from "@/lib/db";
import { requireUser } from "@/shell/auth/session";
import { MEMBER_IDLE_MINUTES } from "@/shell/auth/security";

export const dynamic = "force-dynamic";

export default async function MemberLayout({ children }: LayoutProps<"/member">) {
  const user = await requireUser();
  const member = await getDb().member.findUnique({ where: { userId: user.id }, select: { memberNo: true } });
  const groups: NavGroup[] = [
    {
      title: null,
      items: [
        { href: "/member", label: "Home", icon: "home", exact: true },
        { href: "/member/loans", label: "My loans", icon: "loans" },
        { href: "/member/history", label: "Loan history", icon: "history" },
        { href: "/member/credit", label: "Overpayment Credit", icon: "coins" },
      ],
    },
    { title: "Account", items: [{ href: "/member/profile", label: "My details", icon: "user" }] },
  ];
  return (
    <>
      <AppShell
        area="Member portal"
        homeHref="/member"
        groups={groups}
        user={{ name: user.name, detail: member?.memberNo ?? "Member", accountHref: "/member/profile" }}
        phoneMenu={false}
        narrow
      >
        {children}
      </AppShell>
      <MemberTabs />
      <SessionActivity idleMinutes={MEMBER_IDLE_MINUTES} />
    </>
  );
}
