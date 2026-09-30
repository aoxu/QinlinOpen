import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

export const COOKIE = '__Host-qinlin';
export function equalSecret(a, b) {
  const hash = v => createHash('sha256').update(String(v)).digest();
  return timingSafeEqual(hash(a), hash(b));
}
export function seal(value, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(secret, 'hex'), iv);
  cipher.setAAD(Buffer.from('qinlin-web-poc-v1'));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
}
export function unseal(value, secret, now = Date.now(), allowExpired = false) {
  try {
    if (!value || value.length > 3800) return null;
    const data = Buffer.from(value, 'base64url');
    const cipher = createDecipheriv('aes-256-gcm', Buffer.from(secret, 'hex'), data.subarray(0, 12));
    cipher.setAAD(Buffer.from('qinlin-web-poc-v1'));
    cipher.setAuthTag(data.subarray(12, 28));
    const result = JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString());
    return Number.isFinite(result.exp) && (allowExpired || result.exp > now) ? result : null;
  } catch { return null; }
}
export function readSession(request, secret, allowExpired = false) {
  const value = request.headers.get('Cookie')?.split(';').map(v => v.trim()).find(v => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  return unseal(value, secret, Date.now(), allowExpired);
}
// Browser storage lifetime is renewed on use; it is not the upstream login lifetime.
export function cookie(value, maxAge = 400 * 86400) {
  return `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}
