"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { authClient } from "@/shell/auth/auth-client";

const REFRESH_EVERY_MS = 60_000;

/**
 * Keeps the session alive only while the person is actually using the page
 * (PRD F1 idle timeouts). Input events refresh the session at most once a
 * minute; with no input for `idleMinutes`, the page goes to the sign-in screen.
 * The server enforces the same limit independently.
 */
export function SessionActivity({ idleMinutes }: { idleMinutes: number }) {
  const router = useRouter();
  const lastInput = useRef(0);
  const lastRefresh = useRef(0);

  useEffect(() => {
    const start = Date.now();
    lastInput.current = start;
    lastRefresh.current = start;
    const toSignIn = () => {
      router.replace("/sign-in?reason=idle");
      router.refresh();
    };

    const onInput = () => {
      const now = Date.now();
      lastInput.current = now;
      if (now - lastRefresh.current < REFRESH_EVERY_MS) return;
      lastRefresh.current = now;
      void authClient.getSession().then(({ data }) => {
        if (!data) toSignIn();
      });
    };

    const timer = window.setInterval(() => {
      if (Date.now() - lastInput.current > idleMinutes * 60_000) toSignIn();
    }, 30_000);

    const events = ["pointerdown", "keydown", "scroll", "touchstart"] as const;
    events.forEach((e) => window.addEventListener(e, onInput, { passive: true }));
    return () => {
      window.clearInterval(timer);
      events.forEach((e) => window.removeEventListener(e, onInput));
    };
  }, [idleMinutes, router]);

  return null;
}
