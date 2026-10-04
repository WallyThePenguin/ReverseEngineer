// Text from Google (an email, a calendar event) made safe to store. Postgres refuses a NUL
// character in text, and a lone half of a UTF-16 surrogate pair in JSON; one message carrying
// either used to fail the whole sync, every minute, forever (6.2).

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/** U+FFFD, the character shown for one that can't be read. */
const REPLACEMENT = String.fromCharCode(0xfffd);

/** The text without NULs, and with broken characters shown as the replacement character. */
export function cleanText(s: string): string {
  return s.replaceAll("\u0000", "").replace(LONE_SURROGATE, REPLACEMENT);
}

/**
 * Every string in a parsed value cleaned: in plain objects and arrays, however deep. Anything
 * else (Buffers, dates) is left as it is.
 */
export function cleanDeep<T>(value: T): T {
  if (typeof value === "string") return cleanText(value) as T;
  if (Array.isArray(value)) return value.map(cleanDeep) as T;
  if (value !== null && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanDeep(v)])) as T;
  }
  return value;
}
