/** Same person, loosely: the same words in any order, ignoring case and punctuation, or one name's words all within the other's. */
export function sameName(a: string, b: string): boolean {
  const words = (s: string) => s.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean).sort().join(" ");
  const x = words(a);
  const y = words(b);
  if (!x || !y) return false;
  return x === y || x.split(" ").every((w) => y.includes(w)) || y.split(" ").every((w) => x.includes(w));
}
