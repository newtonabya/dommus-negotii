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
        <div className="mx-auto flex max-w-3xl items-center gap-4 px-4 py-3">
          <span className="font-semibold">Dommus Negotii</span>
          <div className="ml-auto flex items-center gap-4 text-sm">
            <span className="text-muted">{user.name}</span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">{children}</main>
      <SessionActivity idleMinutes={MEMBER_IDLE_MINUTES} />
    </div>
  );
}
