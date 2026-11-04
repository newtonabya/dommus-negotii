import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ApplicationForm, type ApplicationValues } from "@/components/loans/application-form";
import { Alert, Card } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { todayInLagos } from "@/lib/dates";
import { requireUser } from "@/shell/auth/session";
import { getRateSetting } from "@/shell/settings/settings";
import { beginLoanUploadAction, finishLoanUploadAction, saveApplicationAction } from "../actions";

export const metadata: Metadata = { title: "Apply for a loan" };

export default async function ApplyPage({ searchParams }: PageProps<"/member/loans/apply">) {
  const user = await requireUser();
  const { draft } = await searchParams;
  const db = getDb();
  const member = await db.member.findUnique({ where: { userId: user.id } });
  if (!member) redirect("/member");
  const today = todayInLagos();
  const rate = await getRateSetting(db, "interest_rate_bps", today);

  let initial: Partial<ApplicationValues> | undefined;
  let draftId = "";
  if (typeof draft === "string") {
    const loan = await db.loan.findFirst({ where: { id: draft, memberId: member.id, status: "DRAFT" }, include: { guarantor: true } });
    if (loan) {
      draftId = loan.id;
      const g = loan.guarantor;
      initial = {
        amount: (loan.amountRequested / 100n).toString(),
        tenure: loan.tenureRequested,
        purpose: loan.purpose,
        guarantorIsMember: Boolean(g?.moaumIdNumber),
        guarantorMoaumId: g?.moaumIdNumber ?? "",
        guarantorName: g?.moaumIdNumber ? "" : (g?.fullName ?? ""),
        guarantorPhone: g?.moaumIdNumber ? "" : (g?.phone ?? ""),
        guarantorAddress: g?.address ?? "",
        guarantorRelationship: g?.relationship ?? "",
        guarantorFormEvidenceId: g?.formEvidenceId ?? "",
      };
    }
  }

  const blocked =
    member.status !== "ACTIVE"
      ? "Only active members can apply for a loan."
      : !member.idScanEvidenceId
        ? "Your ID card scan is missing. Add it under My details before applying."
        : null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/member/loans" className="text-sm underline">
          ← My loans
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Apply for a loan</h1>
        <p className="text-sm text-muted">
          Give the amount, how long you need, what it is for and one guarantor. You need the guarantor form signed by your
          guarantor. A Loan Officer reviews every application and Management approves it.
        </p>
      </div>
      {blocked ? (
        <Alert tone="error">{blocked}</Alert>
      ) : (
        <Card>
          {initial?.guarantorFormEvidenceId ? <Alert tone="info">Your guarantor form from the draft is saved. Upload it again only if it changed.</Alert> : null}
          <ApplicationForm
            rateBps={rate.toString()}
            today={today}
            initial={initial}
            begin={beginLoanUploadAction}
            finish={finishLoanUploadAction}
            onSave={saveApplicationAction.bind(null, draftId)}
            allowDraft
          />
        </Card>
      )}
    </div>
  );
}
