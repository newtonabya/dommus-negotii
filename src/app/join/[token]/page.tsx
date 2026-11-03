import type { Metadata } from "next";
import Link from "next/link";
import { Alert, Card } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { MemberError } from "@/modules/credit/members/invitations";
import { markOpened, usableInvitation } from "@/modules/credit/members/registration";
import { CONSENT_TEXT } from "@/modules/credit/members/rules";
import { listSources } from "@/modules/credit/members/sources";
import { RegistrationForm } from "./registration-form";

export const metadata: Metadata = { title: "Register as a member", robots: { index: false } };
export const dynamic = "force-dynamic";

function maskPhone(e164: string): string {
  return `${e164.slice(0, 7)}•••${e164.slice(-2)}`;
}

export default async function JoinPage({ params }: PageProps<"/join/[token]">) {
  const { token } = await params;
  const db = getDb();

  let invitation;
  try {
    invitation = await usableInvitation(db, token);
  } catch (error) {
    const message = error instanceof MemberError ? error.message : "This registration link isn't valid.";
    return (
      <Shell>
        <Card
          title="Registration link"
          footer={
            <Link href="/sign-in" className="underline">
              Already registered? Sign in
            </Link>
          }
        >
          <Alert tone="error">{message}</Alert>
        </Card>
      </Shell>
    );
  }

  await markOpened(db, invitation);
  const sources = await listSources(db, true);

  return (
    <Shell>
      <RegistrationForm
        token={token}
        fullName={invitation.fullName}
        maskedPhone={maskPhone(invitation.phone)}
        email={invitation.email ?? ""}
        defaultSourceId={invitation.remittanceSourceId ?? ""}
        sources={sources.map((s) => ({ id: s.id, name: s.name }))}
        consentText={CONSENT_TEXT}
      />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex flex-1 justify-center px-4 py-10">
      <div className="w-full max-w-xl">
        <p className="mb-6 text-center text-sm font-semibold tracking-wide text-muted uppercase">
          MOAUM Credit Super Store · Dommus Negotii
        </p>
        {children}
      </div>
    </main>
  );
}
