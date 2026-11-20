/** Every provider call gives up after this long. */
export const SMS_TIMEOUT_MS = 10_000;

export interface HttpReply {
  status: number;
  body: unknown;
}

/** A network failure or timeout: always worth one more try. */
export class SmsNetworkError extends Error {}

async function call(url: string, init: RequestInit): Promise<HttpReply> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(SMS_TIMEOUT_MS) });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    // Never echo the URL: some providers take the key as a query parameter.
    throw new SmsNetworkError(timedOut ? `No answer within ${SMS_TIMEOUT_MS / 1000} seconds` : "Could not reach the SMS provider");
  }
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    // keep the text
  }
  return { status: res.status, body };
}

export function postJson(url: string, json: unknown, headers: Record<string, string> = {}): Promise<HttpReply> {
  return call(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", ...headers }, body: JSON.stringify(json) });
}

export function postForm(url: string, form: Record<string, string>, headers: Record<string, string> = {}): Promise<HttpReply> {
  return call(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", ...headers },
    body: new URLSearchParams(form).toString(),
  });
}

export function getJson(url: string, headers: Record<string, string> = {}): Promise<HttpReply> {
  return call(url, { method: "GET", headers: { Accept: "application/json", ...headers } });
}

/** Rate limits and provider-side failures can pass; anything else is the request's fault. */
export const retryableStatus = (status: number) => status === 429 || status >= 500;

/** Reads a field from an unknown JSON body without trusting its shape. */
export function field(body: unknown, ...path: string[]): unknown {
  let cur: unknown = body;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export const text = (value: unknown): string | undefined => (value === undefined || value === null || value === "" ? undefined : String(value));

/** Parses "15,585.41", "NGN 100.00" or 9884.24 into a number. */
export function money(value: unknown): number {
  if (typeof value === "number") return value;
  const n = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

/** The result for a network failure or timeout. */
export function networkFailure(error: unknown) {
  return {
    ok: false as const,
    status: "failed" as const,
    raw: null,
    error: error instanceof Error ? error.message : "Could not reach the SMS provider",
    retryable: true,
  };
}
