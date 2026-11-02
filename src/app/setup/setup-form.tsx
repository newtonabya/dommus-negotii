"use client";

import { useActionState } from "react";
import { Alert, Button, Card, Field, Input } from "@/components/ui/form";
import { createFirstAdmin, type SetupState } from "./actions";

export function SetupForm() {
  const [state, action, pending] = useActionState<SetupState, FormData>(createFirstAdmin, {});
  return (
    <Card title="Create the first Admin">
      <p className="text-sm text-muted">
        This page works once, while no Admin exists. The setup token is the <code>SETUP_TOKEN</code> value in the
        server&apos;s environment. Remove it after setup.
      </p>
      <form action={action} className="flex flex-col gap-4">
        <Field label="Setup token">
          <Input name="token" type="password" autoComplete="off" required />
        </Field>
        <Field label="Full name">
          <Input name="name" autoComplete="name" required />
        </Field>
        <Field label="Email">
          <Input name="email" type="email" autoComplete="email" required />
        </Field>
        <Field label="Password" hint="At least 10 characters.">
          <Input name="password" type="password" autoComplete="new-password" minLength={10} required />
        </Field>
        {state.error ? <Alert tone="error">{state.error}</Alert> : null}
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create Admin"}
        </Button>
      </form>
    </Card>
  );
}
