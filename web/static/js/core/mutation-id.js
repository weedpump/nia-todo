/** Durable mutation identities must stay unique even without randomUUID (HTTP). */
export function createMutationId(prefix = '') {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === 'function') return `${prefix}${crypto.randomUUID()}`;
  if (typeof crypto?.getRandomValues !== 'function') {
    throw new Error('Secure random number generation is unavailable');
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return `${prefix}${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
