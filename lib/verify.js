/**
 * Slack request signature verification (v0 scheme).
 *
 * Slack signs every HTTP request with HMAC-SHA256 over
 * `v0:{timestamp}:{rawBody}` using your app's signing secret, and sends the
 * result as `x-slack-signature` (hex, prefixed `v0=`) alongside
 * `x-slack-request-timestamp`.
 *
 * Verification MUST use the exact raw request bytes — any body parsing or
 * re-serialization before this step breaks the signature.
 *
 * Uses WebCrypto's crypto.subtle.verify, which performs the comparison
 * internally (no hand-rolled constant-time compare to get wrong).
 */

const encoder = new TextEncoder();

/**
 * Verify a Slack request signature.
 *
 * @param {Object} options
 * @param {string} options.signingSecret
 * @param {string|number} options.timestamp - x-slack-request-timestamp (unix seconds)
 * @param {string} options.signature - x-slack-signature ("v0=<hex>")
 * @param {string} options.rawBody - Exact raw request body
 * @param {number} [options.now] - Current time in ms (for tests)
 * @param {number} [options.toleranceMs] - Replay window (default 5 minutes)
 * @returns {Promise<{ok: true} | {ok: false, reason: 'missing_headers'|'stale_timestamp'|'bad_signature'}>}
 */
export async function verifySlackSignature({
  signingSecret,
  timestamp,
  signature,
  rawBody,
  now = Date.now(),
  toleranceMs = 300_000,
}) {
  if (!signingSecret) {
    throw new Error('verifySlackSignature requires a signingSecret');
  }

  if (!timestamp || !signature || typeof signature !== 'string' || !signature.startsWith('v0=')) {
    return { ok: false, reason: 'missing_headers' };
  }

  const timestampMs = Number(timestamp) * 1000;
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > toleranceMs) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  const hex = signature.slice(3);
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    return { ok: false, reason: 'bad_signature' };
  }

  const signatureBytes = Uint8Array.from(
    hex.match(/../g).map((byte) => parseInt(byte, 16))
  );

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    signatureBytes,
    encoder.encode(`v0:${timestamp}:${rawBody}`)
  );

  return valid ? { ok: true } : { ok: false, reason: 'bad_signature' };
}
