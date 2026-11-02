"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/shell/auth/auth-client";

export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      className="text-sm underline disabled:opacity-50"
      onClick={async () => {
        setBusy(true);
        await authClient.signOut();
        router.replace("/sign-in");
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
