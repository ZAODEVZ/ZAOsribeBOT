import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Short hash for log + webhook correlation. Strips PII (usernames) from log
 * lines without losing the ability to correlate events for the same speaker.
 * 8 hex chars is enough collision space for a single recording session.
 */
export function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

/**
 * HMAC-SHA256 signature over `${timestamp}.${rawBody}`. The receiver must use
 * the same scheme + verify timestamp recency (<= 5min) to prevent replay.
 */
export function hmacSign(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
