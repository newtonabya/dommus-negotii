import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { adminExists } from "@/shell/users/users";
import { SetupForm } from "./setup-form";

export const metadata: Metadata = { title: "First-time setup" };
export const dynamic = "force-dynamic";

export default async function SetupPage() {
  if (!process.env.SETUP_TOKEN || (await adminExists())) notFound();
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <SetupForm />
      </div>
    </main>
  );
}
