import type { Metadata } from "next";
import Link from "next/link";
import { Alert, Card } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { MemberError } from "@/modules/credit/members/invitations";
import { CONSENT_TEXT } from "@/modules/credit/members/rules";
import { signInLinkDetails } from "@/modules/credit/members/sign-in-links";
import { SetPasswordForm } from "./set-password-form";

export const metadata: Metadata = { title: "Set your password", robots: { index: false } };
export const dynamic = "force-dynamic";

/** A sign-in link from a Loan Officer: the member chooses a password, no SMS code needed. */
export default async function AccessPage({ params }: PageProps<"/access/[token]">) {
  const { token } = await params;
  let details;
  try {
    details = await signInLinkDetails(getDb(), token);
  } catch (error) {
    return (
      <Card
        title="Sign-in link"
        footer={
          <Link href="/sign-in" className="underline">
            Go to sign in
          </Link>
        }
      >
        <Alert tone="error">{error instanceof MemberError ? error.message : "This sign-in link isn't valid."}</Alert>
      </Card>
    );
  }
  return (
    <SetPasswordForm
      token={token}
      firstName={details.fullName.split(" ")[0] ?? details.fullName}
      memberNo={details.memberNo}
      maskedPhone={`${details.phone.slice(0, 7)}•••${details.phone.slice(-2)}`}
      consentText={details.needsConsent ? CONSENT_TEXT : null}
    />
  );
}
