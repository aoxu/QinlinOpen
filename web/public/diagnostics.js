export const BUILD = 'web-unlock-guard-v6';
export function redact(value, secrets = []) {
  let text = String(value ?? '');
  for (const secret of [...secrets].filter(v => typeof v === 'string' && v.length >= 4).sort((a,b) => b.length-a.length)) {
    text = text.split(secret).join('[REDACTED]');
    text = text.split(encodeURIComponent(secret)).join('[REDACTED]');
  }
  return text
    .replace(/https?:\/\/[^\s<>"']+/gi, raw => { try { const u = new URL(raw); return `${u.protocol}//${u.host}${u.pathname}${u.search ? '?[REDACTED]' : ''}`; } catch { return '[URL]'; } })
    .replace(/((?:sessionId|sessionID|token|smsCode|mobile|phone|password|sign|appsecret|authorization|cookie)\s*[=:]\s*)[^\s,;]+/gi,'$1[REDACTED]')
    .replace(/\b\d{6,}\b/g,'[REDACTED_NUMBER]')
    .replace(/\b[a-f\d]{32,}\b/gi,'[REDACTED_HEX]')
    .replace(/[\r\n\t]/g,' ').slice(0,320);
}
// A strict allowlist prevents payloads, headers, response bodies or stack traces entering exports.
const fields = new Set(['time','source','event','requestId','operation','host','path','stage','status','upstreamStatus','businessCode','elapsedMs','contentType','responseBytes','bodyFormat','errorName','errorMessage','causeName','causeMessage','causeCode','colo','build']);
export function safeEntry(entry, secrets = []) {
  const result = {};
  for (const [name,value] of Object.entries(entry)) {
    if (!fields.has(name) || value == null) continue;
    if (typeof value === 'number' || typeof value === 'boolean') result[name] = value;
    else if (typeof value === 'string') result[name] = redact(value,secrets);
  }
  return result;
}
export function createLogBuffer(max = 80) {
  const entries = [];
  return {
    append(entry, secrets = []) { entries.push(safeEntry(entry,secrets)); entries.splice(0,Math.max(0,entries.length-max)); },
    snapshot() { return entries.map(entry => ({...entry})); },
    clear() { entries.length = 0; },
    export() { return JSON.stringify({build:BUILD,exportedAt:new Date().toISOString(),logs:entries},null,2); }
  };
}
