import type { Metadata } from "next";
import Link from "next/link";
import { Alert, Card } from "@/components/ui/form";
import { ResetPasswordForm } from "./reset-password-form";

export const metadata: Metadata = { title: "Set your password" };

export default async function ResetPasswordPage({ searchParams }: PageProps<"/reset-password">) {
  const { token, error } = await searchParams;
  if (typeof token !== "string" || error) {
    return (
      <Card
        title="This link has expired"
        footer={
          <Link href="/forgot-password" className="underline">
            Ask for a new link
          </Link>
        }
      >
        <Alert tone="error">Password links work once and expire after 1 hour.</Alert>
      </Card>
    );
  }
  return <ResetPasswordForm token={token} />;
}
