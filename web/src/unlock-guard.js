import { createHmac } from 'node:crypto';
import { equalSecret } from './session.js';

const RETENTION_MS = 24 * 60 * 60 * 1000;
const COOLDOWNS = [60, 300, 900, 3600];
export function unlockIdentity(ip, key) {
  return createHmac('sha256', key).update(`unlock:${ip}`).digest('hex');
}
export async function verifyTurnstile(token, ip, env, transport = fetch) {
  if (typeof token !== 'string' || !token || token.length > 2048) return false;
  const hostnames = (env.TURNSTILE_HOSTNAMES ?? '').split(',').map(v=>v.trim()).filter(Boolean);
  if (!env.TURNSTILE_SECRET || !hostnames.length) return false;
  const response = await transport('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({secret:env.TURNSTILE_SECRET,response:token,remoteip:ip}),
    signal:AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error('Verification unavailable');
  const result = await response.json();
  return result.success === true && result.action === 'unlock' && hostnames.includes(result.hostname);
}

// One object per HMAC(IP). Serialize verification and updates across all data centers.
// Storage contains counters and timestamps only; requests are never logged or persisted.
export class UnlockGuard {
  constructor(ctx, env, verifier = verifyTurnstile) { this.ctx = ctx; this.env = env; this.verifier = verifier; }
  async fetch(request) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      let state = await this.ctx.storage.get('state');
      if (!state || state.expires <= now) state = {failures:0,blockedUntil:0,expires:now + RETENTION_MS};
      if (state.blockedUntil > now) {
        const retryAfter = Math.ceil((state.blockedUntil - now)/1000);
        return Response.json({error:`访问验证暂时锁定，请 ${retryAfter} 秒后再试`,retryAfter}, {status:429});
      }
      const {password, token, ip} = await request.json();
      let verified;
      try { verified = await this.verifier(token, ip, this.env); }
      catch { return Response.json({error:'安全验证服务暂不可用，请稍后再试'}, {status:503}); }
      if (verified && typeof password === 'string' && equalSecret(password, this.env.ACCESS_PASSWORD)) {
        await this.ctx.storage.deleteAll();
        return Response.json({ok:true});
      }
      state.failures++;
      state.expires = now + RETENTION_MS;
      if (state.failures >= 5) state.blockedUntil = now + COOLDOWNS[Math.min(state.failures - 5,3)] * 1000;
      await this.ctx.storage.put('state',state);
      await this.ctx.storage.setAlarm(state.expires);
      const retryAfter = Math.max(0,Math.ceil((state.blockedUntil - now)/1000));
      return Response.json({error:verified ? '访问密码错误' : '安全验证失败，请重新验证',retryAfter}, {status:retryAfter ? 429 : verified ? 401 : 403});
    });
  }
  async alarm() { await this.ctx.storage.deleteAll(); }
}
