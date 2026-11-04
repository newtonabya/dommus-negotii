import type { Metadata } from "next";
import Link from "next/link";
import { ApplicationForm } from "@/components/loans/application-form";
import { Card } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { todayInLagos } from "@/lib/dates";
import { requireStaffPermission } from "@/shell/auth/session";
import { getRateSetting } from "@/shell/settings/settings";
import { captureApplicationAction } from "./actions";

export const metadata: Metadata = { title: "Capture paper application" };

export default async function NewLoanPage() {
  await requireStaffPermission("loan.application.captureAssisted");
  const today = todayInLagos();
  const rate = await getRateSetting(getDb(), "interest_rate_bps", today);
  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/staff/loans" className="text-sm underline">
          ← Loans
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Capture a paper application</h1>
        <p className="text-sm text-muted">
          For a member who applied on a signed paper form. Upload the signed application and the signed guarantor form;
          the application is submitted straight away and checked against the borrowing and guarantee limits.
        </p>
      </div>
      <Card>
        <ApplicationForm rateBps={rate.toString()} today={today} assisted onSave={captureApplicationAction} />
      </Card>
    </div>
  );
}
