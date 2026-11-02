import type { Metadata } from "next";
import { Alert, Button, Card, Field, Input, Select } from "@/components/ui/form";
import { requireStaffPermission } from "@/shell/auth/session";
import { ASSIGNABLE_ROLES, listUsers } from "@/shell/users/users";
import {
  assignRoleAction,
  createStaffAction,
  deactivateAction,
  reactivateAction,
  resendLinkAction,
  revokeRoleAction,
} from "./actions";

export const metadata: Metadata = { title: "Users & roles" };

export default async function UsersPage({ searchParams }: PageProps<"/staff/admin/users">) {
  const actor = await requireStaffPermission("users.manage");
  const { ok, error } = await searchParams;
  const users = await listUsers();

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Users &amp; roles</h1>
      {typeof ok === "string" ? <Alert tone="success">{ok}</Alert> : null}
      {typeof error === "string" ? <Alert tone="error">{error}</Alert> : null}

      <Card title="Add a staff member">
        <p className="text-sm text-muted">
          They get an email with a link to set their own password (valid 1 hour), then set up two-factor login at
          first sign-in. Assign roles below once they appear in the list.
        </p>
        <form action={createStaffAction} className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field label="Full name">
            <Input name="name" required minLength={2} />
          </Field>
          <Field label="Email">
            <Input name="email" type="email" required />
          </Field>
          <Button type="submit">Create</Button>
        </form>
      </Card>

      <div className="overflow-x-auto rounded-lg border border-border bg-surface">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-border text-xs text-muted uppercase">
            <tr>
              <th className="px-4 py-3">User</th>
              <th className="px-4 py-3">Roles</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const held = new Set(u.roles.map((r) => r.role as string));
              const self = u.id === actor.id;
              return (
                <tr key={u.id} className="border-b border-border align-top last:border-0">
                  <td className="px-4 py-3">
                    <div className="font-medium">{u.name}</div>
                    <div className="text-muted">{u.email}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {u.roles.length === 0 ? <span className="text-muted">None</span> : null}
                      {u.roles.map((r) => (
                        <form key={r.role} action={revokeRoleAction}>
                          <input type="hidden" name="userId" value={u.id} />
                          <input type="hidden" name="role" value={r.role} />
                          <button
                            type="submit"
                            className="rounded-full border border-border px-2 py-0.5 text-xs hover:border-danger hover:text-danger"
                            title={`Remove ${r.role}`}
                            disabled={self && r.role === "ADMIN"}
                          >
                            {r.role} {self && r.role === "ADMIN" ? "" : "×"}
                          </button>
                        </form>
                      ))}
                    </div>
                    {!u.deactivatedAt ? (
                      <form action={assignRoleAction} className="mt-2 flex gap-2">
                        <input type="hidden" name="userId" value={u.id} />
                        <Select name="role" aria-label={`Role for ${u.name}`} className="w-auto py-1 text-xs" defaultValue="">
                          <option value="" disabled>
                            Add role…
                          </option>
                          {ASSIGNABLE_ROLES.filter((r) => !held.has(r)).map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </Select>
                        <Button type="submit" variant="secondary" className="px-2 py-1 text-xs">
                          Add
                        </Button>
                      </form>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    {u.deactivatedAt ? (
                      <span className="text-danger">Deactivated</span>
                    ) : (
                      <span>Active</span>
                    )}
                    <div className="text-xs text-muted">2FA {u.twoFactorEnabled ? "on" : "not set up"}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-2">
                      {u.deactivatedAt ? (
                        <form action={reactivateAction}>
                          <input type="hidden" name="userId" value={u.id} />
                          <Button type="submit" variant="secondary" className="px-2 py-1 text-xs">
                            Reactivate
                          </Button>
                        </form>
                      ) : self ? null : (
                        <form action={deactivateAction} className="flex gap-2">
                          <input type="hidden" name="userId" value={u.id} />
                          <Input name="reason" placeholder="Reason" required minLength={3} className="py-1 text-xs" />
                          <Button type="submit" variant="danger" className="px-2 py-1 text-xs">
                            Deactivate
                          </Button>
                        </form>
                      )}
                      {!u.deactivatedAt ? (
                        <form action={resendLinkAction}>
                          <input type="hidden" name="email" value={u.email} />
                          <button type="submit" className="text-xs underline">
                            Send password link
                          </button>
                        </form>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
