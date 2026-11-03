import { providerFor } from "@/shell/notifications/providers";

const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;
const keys = { TERMII_API_KEY: "k", TERMII_SENDER_ID: "MOAUM", RESEND_API_KEY: "k", RESEND_FROM: "x <x@example.com>" };

describe("notification provider choice (PRD F2)", () => {
  it("uses Termii and Resend when configured", () => {
    expect(providerFor("SMS", env({ NODE_ENV: "production", ...keys })).name).toBe("termii");
    expect(providerFor("EMAIL", env({ NODE_ENV: "production", ...keys })).name).toBe("resend");
  });

  it("refuses to fall back to the console in production", () => {
    expect(() => providerFor("SMS", env({ NODE_ENV: "production" }))).toThrow(/No SMS provider/);
  });

  it("never sends from staging, even with provider keys set", () => {
    const staging = env({ NODE_ENV: "production", APP_STAGE: "staging", ...keys });
    expect(providerFor("SMS", staging).name).toBe("console");
    expect(providerFor("EMAIL", staging).name).toBe("console");
  });
});
