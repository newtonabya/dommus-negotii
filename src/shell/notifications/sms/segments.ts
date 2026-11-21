/**
 * How many SMS units a message costs. GSM-7 text: 160 characters in one
 * message, 153 per part when split. Anything outside GSM-7 (emoji, ₦, smart
 * quotes) switches the whole message to UCS-2: 70, then 67 per part. Each
 * part is billed, so templates should stay at one or two.
 */

const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
/** These take two GSM-7 characters each (escape + character). */
const GSM_EXTENDED = "^{}\\[~]|€\f";

export interface SegmentCount {
  encoding: "GSM-7" | "UCS-2";
  /** Characters as the network counts them (extended GSM characters count twice). */
  length: number;
  segments: number;
}

export function countSegments(message: string): SegmentCount {
  let gsmLength = 0;
  let gsm = true;
  for (const ch of message) {
    if (GSM_BASIC.includes(ch)) gsmLength += 1;
    else if (GSM_EXTENDED.includes(ch)) gsmLength += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) {
    return { encoding: "GSM-7", length: gsmLength, segments: gsmLength === 0 ? 1 : gsmLength <= 160 ? 1 : Math.ceil(gsmLength / 153) };
  }
  // UCS-2 counts UTF-16 code units: an emoji is two.
  const length = message.length;
  return { encoding: "UCS-2", length, segments: length <= 70 ? 1 : Math.ceil(length / 67) };
}

/** Templates longer than this many units get a warning in development. */
export const SEGMENT_WARNING = 2;
