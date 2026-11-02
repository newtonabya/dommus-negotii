import type { Metadata } from "next";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

const REASONS: Record<string, string> = {
  idle: "You were signed out after a period of inactivity.",
  deactivated: "This account has been deactivated. Contact the Admin.",
  "signed-out": "Please sign in to continue.",
  "password-set": "Your password is set. Sign in with it now.",
  "setup-done": "The Admin account is ready. Sign in to set up two-factor login.",
};

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const { reason } = await searchParams;
  const notice = typeof reason === "string" ? REASONS[reason] : undefined;
  return <SignInForm notice={notice} />;
}
