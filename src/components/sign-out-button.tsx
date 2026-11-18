"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Icon } from "@/components/icons";
import { authClient } from "@/shell/auth/auth-client";

export function SignOutButton({ variant = "plain" }: { variant?: "plain" | "sidebar" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      title="Sign out"
      className={
        variant === "sidebar"
          ? "inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2.5 text-sm font-semibold whitespace-nowrap text-sidebar-fg hover:bg-white/10 hover:text-white disabled:opacity-50"
          : "inline-flex min-h-11 items-center rounded-xl px-3 whitespace-nowrap text-sm font-bold text-accent hover:bg-accent/5 disabled:opacity-50"
      }
      onClick={async () => {
        setBusy(true);
        await authClient.signOut();
        router.replace("/sign-in");
        router.refresh();
      }}
    >
      {variant === "sidebar" ? (
        <>
          <Icon name="signOut" className="h-[18px] w-[18px]" />
          <span className="sr-only sm:not-sr-only lg:sr-only">Sign out</span>
        </>
      ) : (
        "Sign out"
      )}
    </button>
  );
}
