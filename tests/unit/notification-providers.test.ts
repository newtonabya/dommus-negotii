import { providerFor } from "@/shell/notifications/providers";

const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;
const keys = { SMS_PROVIDER: "bulksmsnigeria", BULKSMSNIGERIA_API_TOKEN: "k", SMS_SENDER_ID: "MOAUMCSL", RESEND_API_KEY: "k", RESEND_FROM: "x <x@example.com>" };

describe("notification provider choice (PRD F2)", () => {
  it("sends SMS through the SMS module and email through Resend", () => {
    expect(providerFor("SMS", env({ NODE_ENV: "production", ...keys })).name).toBe("sms");
    expect(providerFor("EMAIL", env({ NODE_ENV: "production", ...keys })).name).toBe("resend");
  });

  it("refuses to send email from production without Resend", () => {
    expect(() => providerFor("EMAIL", env({ NODE_ENV: "production" }))).toThrow(/No EMAIL provider/);
  });

  it("reports SMS problems in production instead of printing to the console", async () => {
    const result = await providerFor("SMS", env({ NODE_ENV: "production", SMS_PROVIDER: "log" })).send({ channel: "SMS", to: "08031234567", text: "Hi" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/SMS_PROVIDER is "log" in production/);
  });

  it("never emails from staging, even with provider keys set", () => {
    const staging = env({ NODE_ENV: "production", APP_STAGE: "staging", ...keys });
    expect(providerFor("EMAIL", staging).name).toBe("console");
  });

  it("skips staging SMS to numbers not on the test list", async () => {
    const staging = env({ NODE_ENV: "production", APP_STAGE: "staging", ...keys, SMS_TEST_RECIPIENTS: "08031234567" });
    const result = await providerFor("SMS", staging).send({ channel: "SMS", to: "08099999999", text: "Hi" });
    expect(result).toMatchObject({ ok: false, skipped: true });
  });
});
