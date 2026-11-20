import { jest } from "@jest/globals";
import { AfricasTalkingAdapter } from "@/shell/notifications/sms/adapters/africastalking";
import { BulkSmsNigeriaAdapter } from "@/shell/notifications/sms/adapters/bulksmsnigeria";
import { KudiSmsAdapter } from "@/shell/notifications/sms/adapters/kudisms";
import { maskCodes } from "@/shell/notifications/sms/adapters/log";
import { SmsToAdapter } from "@/shell/notifications/sms/adapters/smsto";
import { TermiiAdapter } from "@/shell/notifications/sms/adapters/termii";
import { assertSmsConfig, readSmsConfig, smsEnvironment } from "@/shell/notifications/sms/config";
import { parseDeliveryReport } from "@/shell/notifications/sms/delivery";
import { createAdapter } from "@/shell/notifications/sms/factory";
import { blockedOnStaging, sendSms } from "@/shell/notifications/sms";
import { toMsisdn } from "@/shell/notifications/sms/phone";
import { countSegments } from "@/shell/notifications/sms/segments";
import type { AdapterRequest, AdapterResult, SmsAdapter, SmsProviderName } from "@/shell/notifications/sms/types";

const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;
const request: AdapterRequest = { to: "2348031234567", message: "Hello", senderId: "MOAUMCSL", unicode: false };

/** Fakes one HTTP reply and records what was sent. */
function reply(status: number, body: unknown) {
  const spy = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
  return spy;
}
const sentBody = (spy: ReturnType<typeof reply>) => {
  const init = spy.mock.calls[0]?.[1] as RequestInit;
  return typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(String(init.body)));
};
const sentUrl = (spy: ReturnType<typeof reply>) => String(spy.mock.calls[0]?.[0]);
const sentHeaders = (spy: ReturnType<typeof reply>) => (spy.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;

afterEach(() => jest.restoreAllMocks());

describe("phone numbers", () => {
  it.each(["08031234567", "8031234567", "+2348031234567", "2348031234567", "0803 123 4567", "0803-123-4567"])("reads %s", (input) => {
    expect(toMsisdn(input)).toBe("2348031234567");
  });
  it.each(["0803123456", "12345", "+447700900123", "06031234567", "", "080312345678"])("refuses %s", (input) => {
    expect(toMsisdn(input)).toBeNull();
  });
});

describe("SMS units", () => {
  it("counts GSM-7 text in 160s, then 153s", () => {
    expect(countSegments("a".repeat(160))).toEqual({ encoding: "GSM-7", length: 160, segments: 1 });
    expect(countSegments("a".repeat(161)).segments).toBe(2);
    expect(countSegments("a".repeat(306)).segments).toBe(2);
    expect(countSegments("a".repeat(307)).segments).toBe(3);
  });
  it("counts extended characters twice", () => {
    expect(countSegments("{}").length).toBe(4);
  });
  it("switches to UCS-2 for emoji and the naira sign: 70, then 67", () => {
    expect(countSegments("Paid ₦5,000").encoding).toBe("UCS-2");
    expect(countSegments("😀".repeat(35)).segments).toBe(1);
    expect(countSegments("😀".repeat(36)).segments).toBe(2);
  });
});

describe("settings", () => {
  it("knows the environment", () => {
    expect(smsEnvironment(env({ NODE_ENV: "production", APP_STAGE: "staging" }))).toBe("staging");
    expect(smsEnvironment(env({ NODE_ENV: "production" }))).toBe("production");
    expect(smsEnvironment(env({ NODE_ENV: "development" }))).toBe("development");
  });
  it("defaults to the log driver in development", () => {
    const { config, problems } = readSmsConfig(env({ NODE_ENV: "development" }));
    expect(config.provider).toBe("log");
    expect(problems).toEqual([]);
  });
  it("names the missing variable, never a value", () => {
    const { problems } = readSmsConfig(env({ NODE_ENV: "production", SMS_PROVIDER: "bulksmsnigeria", SMS_SENDER_ID: "MOAUMCSL" }));
    expect(problems.join(" ")).toMatch(/BULKSMSNIGERIA_API_TOKEN/);
  });
  it("refuses to start production on the log driver unless SMS is off", () => {
    expect(() => assertSmsConfig(env({ NODE_ENV: "production", SMS_PROVIDER: "log" }))).toThrow(/SMS_PROVIDER is "log" in production/);
    expect(() => assertSmsConfig(env({ NODE_ENV: "production", SMS_PROVIDER: "log", SMS_ENABLED: "false" }))).not.toThrow();
  });
  it("checks the sender ID and the fallback", () => {
    const bad = readSmsConfig(env({ NODE_ENV: "production", SMS_PROVIDER: "termii", TERMII_API_KEY: "k", SMS_SENDER_ID: "MOAUM CSL LTD" }));
    expect(bad.problems.join(" ")).toMatch(/3 to 11 letters or digits/);
    const fb = readSmsConfig(env({ SMS_PROVIDER: "termii", TERMII_API_KEY: "k", SMS_SENDER_ID: "MOAUMCSL", SMS_FALLBACK_PROVIDER: "smsto" }));
    expect(fb.config.fallback).toBe("smsto");
    expect(fb.problems.join(" ")).toMatch(/SMSTO_API_KEY/);
  });
  it("still reads the older Termii-only settings", () => {
    const { config, problems } = readSmsConfig(env({ NODE_ENV: "production", TERMII_API_KEY: "k", TERMII_SENDER_ID: "MOAUMCSL" }));
    expect(config.provider).toBe("termii");
    expect(config.senderId).toBe("MOAUMCSL");
    expect(problems).toEqual([]);
  });
});

describe("factory", () => {
  it.each([
    ["log", "log"],
    ["bulksmsnigeria", "bulksmsnigeria"],
    ["smsto", "smsto"],
    ["africastalking", "africastalking"],
    ["kudisms", "kudisms"],
    ["termii", "termii"],
  ] as const)("builds %s", (name, expected) => {
    expect(createAdapter(name, env({})).name).toBe(expected);
  });
});

describe("staging test numbers", () => {
  const staging = { NODE_ENV: "production", APP_STAGE: "staging", SMS_SENDER_ID: "MOAUMCSL", SMS_TEST_RECIPIENTS: "08031234567" };
  it("only lets listed numbers through to a real provider", () => {
    const e = env({ ...staging, SMS_PROVIDER: "bulksmsnigeria", BULKSMSNIGERIA_API_TOKEN: "t" });
    const { config } = readSmsConfig(e);
    expect(blockedOnStaging(config, "2348031234567", e)).toBe(false);
    expect(blockedOnStaging(config, "2348099999999", e)).toBe(true);
  });
  it("lets everything through the Africa's Talking sandbox and the log driver", () => {
    const at = env({ ...staging, SMS_PROVIDER: "africastalking", AFRICASTALKING_USERNAME: "sandbox", AFRICASTALKING_API_KEY: "k" });
    expect(blockedOnStaging(readSmsConfig(at).config, "2348099999999", at)).toBe(false);
    const log = env({ ...staging, SMS_PROVIDER: "log" });
    expect(blockedOnStaging(readSmsConfig(log).config, "2348099999999", log)).toBe(false);
  });
  it("skips, prefixes and never calls the provider for unlisted numbers", async () => {
    const send = jest.fn<SmsAdapter["send"]>();
    const e = env({ ...staging, SMS_PROVIDER: "bulksmsnigeria", BULKSMSNIGERIA_API_TOKEN: "t" });
    const skipped = await sendSms({ to: "08099999999", message: "Hi" }, { env: e, adapter: () => ({ name: "bulksmsnigeria", send }) });
    expect(skipped.status).toBe("skipped_staging");
    expect(send).not.toHaveBeenCalled();
    send.mockResolvedValue({ ok: true, status: "sent", providerMessageId: "m1", raw: {}, retryable: false });
    const sent = await sendSms({ to: "08031234567", message: "Hi" }, { env: e, adapter: () => ({ name: "bulksmsnigeria", send }) });
    expect(sent.status).toBe("sent");
    expect(send.mock.calls[0]?.[0].message).toBe("[STAGING] Hi");
  });
});

describe("sendSms", () => {
  const prod = env({ NODE_ENV: "production", SMS_PROVIDER: "bulksmsnigeria", BULKSMSNIGERIA_API_TOKEN: "t", SMS_SENDER_ID: "MOAUMCSL", SMS_FALLBACK_PROVIDER: "termii", TERMII_API_KEY: "k" });
  const fake = (results: Partial<Record<SmsProviderName, AdapterResult[]>>) => {
    const calls: SmsProviderName[] = [];
    return {
      calls,
      adapter: (name: SmsProviderName): SmsAdapter => ({
        name,
        send: async () => {
          calls.push(name);
          return results[name]!.shift()!;
        },
      }),
    };
  };
  const down: AdapterResult = { ok: false, status: "failed", raw: null, error: "HTTP 503", retryable: true };
  const refused: AdapterResult = { ok: false, status: "failed", raw: null, error: "BSNG-2013: route", retryable: false };
  const fine: AdapterResult = { ok: true, status: "sent", providerMessageId: "x", raw: {}, retryable: false };
  const sleep = async () => {};

  it("refuses a bad number before calling anyone", async () => {
    const f = fake({});
    const r = await sendSms({ to: "12345", message: "Hi" }, { env: prod, adapter: f.adapter, sleep });
    expect(r).toMatchObject({ ok: false, status: "failed", retryable: false });
    expect(r.error).toMatch(/valid Nigerian mobile/);
    expect(f.calls).toEqual([]);
  });
  it("retries twice on network/5xx, then fails over once", async () => {
    const f = fake({ bulksmsnigeria: [down, down, down], termii: [fine] });
    const r = await sendSms({ to: "08031234567", message: "Hi" }, { env: prod, adapter: f.adapter, sleep });
    expect(f.calls).toEqual(["bulksmsnigeria", "bulksmsnigeria", "bulksmsnigeria", "termii"]);
    expect(r).toMatchObject({ ok: true, provider: "termii", attempts: 4 });
  });
  it("never retries or fails over a validation error", async () => {
    const f = fake({ bulksmsnigeria: [refused], termii: [fine] });
    const r = await sendSms({ to: "08031234567", message: "Hi" }, { env: prod, adapter: f.adapter, sleep });
    expect(f.calls).toEqual(["bulksmsnigeria"]);
    expect(r).toMatchObject({ ok: false, provider: "bulksmsnigeria", retryable: false });
  });
  it("sends no prefix in production and reports the units", async () => {
    const send = jest.fn<SmsAdapter["send"]>().mockResolvedValue(fine);
    const r = await sendSms({ to: "08031234567", message: "Hello" }, { env: prod, adapter: (name) => ({ name, send }), sleep });
    expect(send.mock.calls[0]?.[0]).toMatchObject({ to: "2348031234567", message: "Hello", senderId: "MOAUMCSL", unicode: false });
    expect(r.segments).toBe(1);
  });
  it("does nothing when SMS is off", async () => {
    const r = await sendSms({ to: "08031234567", message: "Hi" }, { env: env({ NODE_ENV: "production", SMS_ENABLED: "false" }) });
    expect(r.status).toBe("disabled");
  });
  it("masks codes in the log driver's output", () => {
    expect(maskCodes("Your code is 482913. Never share it.")).toBe("Your code is ••••••. Never share it.");
  });
});

describe("BulkSMSNigeria adapter (v2)", () => {
  const a = new BulkSmsNigeriaAdapter("tok", { gateway: "corporate" });
  it("sends with the Bearer token and reads the message id", async () => {
    const spy = reply(200, { status: "success", code: "BSNG-0000", message: "Message sent successfully", data: { message_id: "bsng-1", cost: 5, currency: "NGN", gateway_used: "corporate", page_count: 1 } });
    const r = await a.send({ ...request, callbackUrl: "https://moaumcsl.com/api/v1/sms/delivery/bulksmsnigeria?token=s" });
    expect(sentUrl(spy)).toBe("https://www.bulksmsnigeria.com/api/v2/sms");
    expect(sentHeaders(spy).Authorization).toBe("Bearer tok");
    expect(sentBody(spy)).toMatchObject({ from: "MOAUMCSL", to: "2348031234567", body: "Hello", gateway: "corporate", callback_url: expect.stringContaining("token=s") });
    expect(r).toMatchObject({ ok: true, providerMessageId: "bsng-1" });
  });
  it("treats a route refusal as final and a 503 as retryable", async () => {
    reply(422, { status: "error", code: "BSNG-2013", error: { message: "Message not permitted on this route", code: "BSNG-2013" } });
    expect(await a.send(request)).toMatchObject({ ok: false, retryable: false, error: "BSNG-2013: Message not permitted on this route" });
    jest.restoreAllMocks();
    reply(503, "Service Unavailable");
    expect(await a.send(request)).toMatchObject({ ok: false, retryable: true });
  });
  it("treats a timeout as retryable without leaking the URL", async () => {
    jest.spyOn(globalThis, "fetch").mockRejectedValue(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
    const r = await a.send(request);
    expect(r).toMatchObject({ ok: false, retryable: true });
    expect(r.error).not.toMatch(/bulksmsnigeria|tok/);
  });
  it("reads the balance", async () => {
    reply(200, { data: { status: "success", message: "Balance Inquiry Successful" }, balance: { total_balance: 9884.24, universal_wallet: "9879.23" } });
    expect((await a.getBalance()).amount).toBe(9884.24);
  });
});

describe("SMS.to adapter", () => {
  const a = new SmsToAdapter("key");
  it("sends JSON with a plus-prefixed number", async () => {
    const spy = reply(200, { success: true, message: "Message is queued for sending! Please check Logs for its status.", message_id: "smsto-1" });
    const r = await a.send(request);
    expect(sentUrl(spy)).toBe("https://api.sms.to/sms/send");
    expect(sentHeaders(spy).Authorization).toBe("Bearer key");
    expect(sentBody(spy)).toMatchObject({ to: "+2348031234567", message: "Hello", sender_id: "MOAUMCSL" });
    expect(r).toMatchObject({ ok: true, status: "queued", providerMessageId: "smsto-1" });
  });
  it("reads success: false as a refusal", async () => {
    reply(400, { success: false, message: "Invalid sender id" });
    expect(await a.send(request)).toMatchObject({ ok: false, retryable: false, error: "Invalid sender id" });
  });
});

describe("Africa's Talking adapter", () => {
  it("posts the form to the sandbox and reads the recipient", async () => {
    const spy = reply(201, { SMSMessageData: { Message: "Sent to 1/1 Total Cost: NGN 2.20", Recipients: [{ statusCode: 101, number: "+2348031234567", status: "Success", cost: "NGN 2.20", messageId: "ATXid_1" }] } });
    const r = await new AfricasTalkingAdapter("sandbox", "key", true).send(request);
    expect(sentUrl(spy)).toBe("https://api.sandbox.africastalking.com/version1/messaging");
    expect(sentHeaders(spy).apiKey).toBe("key");
    expect(sentBody(spy)).toEqual({ username: "sandbox", to: "+2348031234567", message: "Hello" });
    expect(r).toMatchObject({ ok: true, providerMessageId: "ATXid_1" });
  });
  it("reads a per-recipient refusal", async () => {
    reply(201, { SMSMessageData: { Message: "Sent to 0/1", Recipients: [{ statusCode: 403, number: "+2348031234567", status: "InvalidPhoneNumber" }] } });
    expect(await new AfricasTalkingAdapter("moaum", "key", false).send(request)).toMatchObject({ ok: false, retryable: false, error: "403 InvalidPhoneNumber" });
  });
});

describe("KudiSMS adapter", () => {
  it("sends on the corporate route and takes the id after the pipe", async () => {
    const spy = reply(200, { status: "success", error_code: "000", cost: "3.50", data: "2348031234567|98a0ca4c-8609-92a0-9f68-cfaf59c78da6", msg: "Message received Successfully" });
    const r = await new KudiSmsAdapter("tok").send(request);
    expect(sentUrl(spy)).toBe("https://my.kudisms.net/api/corporate");
    expect(sentBody(spy)).toEqual({ token: "tok", senderID: "MOAUMCSL", recipients: "2348031234567", message: "Hello" });
    expect(r).toMatchObject({ ok: true, providerMessageId: "98a0ca4c-8609-92a0-9f68-cfaf59c78da6" });
  });
  it("reads an error code even on HTTP 200", async () => {
    reply(200, { status: "error", error_code: "109", msg: "Insufficient credit" });
    expect(await new KudiSmsAdapter("tok", "sms").send(request)).toMatchObject({ ok: false, retryable: false, error: "109: Insufficient credit" });
  });
});

describe("Termii adapter", () => {
  it("sends on the dnd channel and reads message_id", async () => {
    const spy = reply(200, { code: "ok", balance: 1047.57, message_id: "3017544054459083819856413", message: "Successfully Sent", user: "MOAUM", message_id_str: "3017544054459083819856413" });
    const r = await new TermiiAdapter("key", "https://v3.api.termii.com/", "dnd").send(request);
    expect(sentUrl(spy)).toBe("https://v3.api.termii.com/api/sms/send");
    expect(sentBody(spy)).toEqual({ api_key: "key", to: "2348031234567", from: "MOAUMCSL", sms: "Hello", type: "plain", channel: "dnd" });
    expect(r).toMatchObject({ ok: true, providerMessageId: "3017544054459083819856413" });
  });
  it("treats 401 as a refusal and 429 as retryable", async () => {
    reply(401, { message: "No valid API key provided" });
    expect(await new TermiiAdapter("key", "https://x").send(request)).toMatchObject({ ok: false, retryable: false });
    jest.restoreAllMocks();
    reply(429, { message: "Too Many Requests" });
    expect(await new TermiiAdapter("key", "https://x").send(request)).toMatchObject({ ok: false, retryable: true });
  });
});

describe("delivery reports", () => {
  it("reads each provider's report", () => {
    expect(parseDeliveryReport("bulksmsnigeria", { message_id: "b1", recipient: "2348031234567", delivery_status: "delivrd" })).toEqual({ providerMessageId: "b1", outcome: "delivered", detail: "delivrd" });
    expect(parseDeliveryReport("bulksmsnigeria", { message_id: "b1", delivery_status: "undeliv" })?.outcome).toBe("failed");
    expect(parseDeliveryReport("bulksmsnigeria", { message_id: "b1", delivery_status: "sent awaiting status" })).toBeNull();
    expect(parseDeliveryReport("smsto", { messageId: "s1", status: "DELIVERED" })?.outcome).toBe("delivered");
    expect(parseDeliveryReport("smsto", { messageId: "s1", status: "SENT" })).toBeNull();
    expect(parseDeliveryReport("africastalking", { id: "a1", status: "Failed", failureReason: "AbsentSubscriber" })?.outcome).toBe("failed");
    expect(parseDeliveryReport("termii", { message_id: "t1", status: "DND Active on Phone Number" })?.outcome).toBe("failed");
    expect(parseDeliveryReport("kudisms", { status: "DELIVRD" })).toBeNull();
  });
});
