import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "sha256=";
const HEX_SHA256 = /^[0-9a-f]{64}$/i;

export function signPayload(rawBody: Uint8Array | string, appSecret: string): string {
  return PREFIX + createHmac("sha256", appSecret).update(rawBody).digest("hex");
}

/**
 * Checks Meta's X-Hub-Signature-256 header against the raw request body.
 *
 * - Must run on the exact bytes Meta sent. Parsing and re-serializing the JSON
 *   changes whitespace and key order, and the check will fail.
 * - Uses a constant-time compare so the response time does not leak how many
 *   leading bytes matched.
 */
export function verifySignature(
  rawBody: Uint8Array | string,
  header: string | null | undefined,
  appSecret: string,
): boolean {
  if (!header || !appSecret) return false;
  if (!header.startsWith(PREFIX)) return false;

  const received = header.slice(PREFIX.length);
  if (!HEX_SHA256.test(received)) return false;

  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const given = Buffer.from(received, "hex");
  // Both are 32 bytes here, but timingSafeEqual throws on a length mismatch,
  // so keep the guard in case the regex above ever changes.
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

/** Constant-time string compare for the GET verify token. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
