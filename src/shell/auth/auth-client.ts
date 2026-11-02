"use client";

import { createAuthClient } from "better-auth/react";
import { phoneNumberClient, twoFactorClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  plugins: [
    twoFactorClient({ twoFactorPage: "/two-factor" }),
    phoneNumberClient(),
  ],
});
