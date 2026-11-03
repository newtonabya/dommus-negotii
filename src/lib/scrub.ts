/**
 * Removes personal data from text bound for logs and error trackers (PRD §5):
 * emails, Nigerian phone numbers, link tokens and long secrets.
 */
export function scrub(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
    .replace(/(\+?234|\b0)[789][01]\d{8}\b/g, "[phone]")
    .replace(/\/join\/[\w-]{16,}/g, "/join/[token]")
    .replace(/([?&](token|code|secret|password)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[secret]");
}
