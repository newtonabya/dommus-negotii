import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUser } from "@/shell/auth/session";
import { TwoFactorSetup } from "./two-factor-setup";

export const metadata: Metadata = { title: "Set up two-factor login" };

export default async function TwoFactorSetupPage() {
  const user = await requireUser();
  if (user.twoFactorEnabled) redirect("/");
  return <TwoFactorSetup required={user.isStaff} />;
}
