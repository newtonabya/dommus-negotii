import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/brand";
import { Alert, Card } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { MemberError } from "@/modules/credit/members/invitations";
import { markOpened, memberForActivation, usableInvitation } from "@/modules/credit/members/registration";
import { CONSENT_TEXT } from "@/modules/credit/members/rules";
import { listSources } from "@/modules/credit/members/sources";
import { ActivationForm } from "./activation-form";
import { RegistrationForm } from "./registration-form";

export const metadata: Metadata = { title: "Join Dommus Negotii", robots: { index: false } };
export const dynamic = "force-dynamic";

function maskPhone(e164: string): string {
  return `${e164.slice(0, 7)}•••${e164.slice(-2)}`;
}

export default async function JoinPage({ params }: PageProps<"/join/[token]">) {
  const { token } = await params;
  const db = getDb();

  let invitation;
  let member = null;
  try {
    invitation = await usableInvitation(db, token);
    if (invitation.type === "ACTIVATION") member = await memberForActivation(db, invitation);
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

  if (member) {
    return (
      <Shell>
        <ActivationForm
          token={token}
          fullName={member.fullName}
          maskedPhone={maskPhone(invitation.phone)}
          needsScan={!member.idScanEvidenceId}
          consentText={CONSENT_TEXT}
        />
      </Shell>
    );
  }

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
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <Logo size={120} priority />
          <p className="text-lg font-extrabold tracking-wide uppercase">MOAUM Credit Super Store</p>
          <div className="brand-rule w-40" aria-hidden="true" />
        </div>
        {children}
      </div>
    </main>
  );
}
