import { Button, Card, Field, Select } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { setPreferredChannelAction } from "@/app/preferences-actions";

/** Where a user's status messages go (PRD F15). One-time codes always go by SMS for members and email for staff. */
export async function ChannelPreference({ userId, page, staff }: { userId: string; page: "/staff/account" | "/member/profile"; staff: boolean }) {
  const user = await getDb().user.findUnique({ where: { id: userId }, select: { preferredChannel: true } });
  return (
    <Card title="How we contact you">
      <form action={setPreferredChannelAction.bind(null, page)} className="flex flex-wrap items-end gap-3">
        <Field label="Send my status messages by" hint={`Sign-in codes always come by ${staff ? "email" : "SMS"}.`}>
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
