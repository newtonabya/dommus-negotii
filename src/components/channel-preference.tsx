import { Button, Card, Field, Select } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { setPreferredChannelAction } from "@/app/preferences-actions";

/**
 * Where a user's status messages go (PRD F15). For members it also picks how
 * one-time codes come (`codeDestination`); staff sign in with an authenticator app.
 */
export async function ChannelPreference({ userId, page, staff }: { userId: string; page: "/staff/account" | "/member/profile"; staff: boolean }) {
  const user = await getDb().user.findUnique({ where: { id: userId }, select: { preferredChannel: true } });
  return (
    <Card title="How we contact you">
      <form action={setPreferredChannelAction.bind(null, page)} className="flex flex-wrap items-end gap-3">
        <Field
          label={staff ? "Send my status messages by" : "Send my messages and codes by"}
          hint={
            staff
              ? "Password links always come by email."
              : "One-time codes follow this choice too, if we have your email. While text messages are switched off, everything comes by email. On the code screen you can always ask for one code the other way."
          }
        >
          <Select name="channel" defaultValue={user?.preferredChannel ?? ""}>
            <option value="">{staff ? "Email (the default for staff)" : "SMS (the default for members)"}</option>
            <option value="SMS">SMS</option>
            <option value="EMAIL">Email</option>
          </Select>
        </Field>
        <Button type="submit">Save</Button>
      </form>
    </Card>
  );
}
