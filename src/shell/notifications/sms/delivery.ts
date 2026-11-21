import { field, text } from "./http";
import type { SmsProviderName } from "./types";

export interface DeliveryReport {
  providerMessageId: string;
  outcome: "delivered" | "failed";
  /** The provider's own words, kept on the log. */
  detail: string;
}

const DELIVERED = /^(delivrd|delivered|success|message delivered.*)$/i;

/**
 * Reads one provider's delivery report. Returns null for in-between states
 * (sent, buffered, queued) and for reports this portal can't match to a
 * message. Shapes from each provider's docs, checked 20 Nov 2026.
 */
export function parseDeliveryReport(provider: SmsProviderName, body: unknown): DeliveryReport | null {
  let id: string | undefined;
  let status: string | undefined;
  let failed: RegExp;
  switch (provider) {
    case "bulksmsnigeria":
      // { message_id, recipient, delivery_status, customer_reference, data: {…} }; anything not delivered is final.
      id = text(field(body, "message_id")) ?? text(field(body, "data", "message_id"));
      status = text(field(body, "delivery_status")) ?? text(field(body, "data", "delivery_status"));
      failed = /.*/;
      break;
    case "smsto":
      // { messageId, phone, status, parts, price }
      id = text(field(body, "messageId"));
      status = text(field(body, "status"));
      failed = /^(failed|rejected|expired|undelivered|undeliverable)$/i;
      break;
    case "africastalking":
      // form fields id, status, phoneNumber, failureReason
      id = text(field(body, "id"));
      status = text(field(body, "status"));
      failed = /^(failed|rejected|absentsubscriber|expired)$/i;
      break;
    case "termii":
      // { message_id, receiver, status, … }
      id = text(field(body, "message_id"));
      status = text(field(body, "status"));
      failed = /^(message failed|rejected|expired|dnd active on phone number)$/i;
      break;
    default:
      // KudiSMS reports carry only the customer's own reference, not the message id we hold.
      return null;
  }
  if (!id || !status) return null;
  if (DELIVERED.test(status)) return { providerMessageId: id, outcome: "delivered", detail: status };
  if (provider === "bulksmsnigeria" && /^(sent|pending|queued|sent awaiting status)/i.test(status)) return null;
  if (failed.test(status)) return { providerMessageId: id, outcome: "failed", detail: status };
  return null;
}
