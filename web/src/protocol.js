import { createHash, createCipheriv, randomInt } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { errorDetails } from './diagnostics.js';
// Keep Workers' native fetch receiver: invoking a stored fetch as this.transport() is illegal.
export const defaultTransport = (url, options) => globalThis.fetch(url, options);

export class ApiError extends Error {
  constructor(message, status = 502, details = {}) { super(message); this.status = status; this.details = details; }
}
export const md5 = value => createHash('md5').update(value, 'utf8').digest('hex').toUpperCase();
export const nonce = length => Array.from({ length }, () => randomInt(10)).join('');
// Matches Java URLEncoder, including its form encoding and the Android client's colon exception.
export const encode = value => encodeURIComponent(String(value))
  .replace(/[!'()~]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  .replace(/%20/g, '+').replace(/%3A/g, ':');
export const encodeQuery = fields => Object.keys(fields).sort()
  .map(key => `${encode(key)}=${encode(fields[key])}`).join('&');
export function signFields(fields, sessionId, salt, timestamp = Date.now(), n = nonce(5)) {
  const sign = md5(`${encodeQuery({ ...fields, nonce: n, timestamp, token: sessionId, version: '5.2.6' })}&key=${salt}`);
  return { ...fields, timestamp, version: '5.2.6', nonce: n, sign };
}
export function encryptPhone(phone, hexKey) {
  const cipher = createCipheriv('aes-128-ecb', Buffer.from(hexKey, 'hex'), Buffer.alloc(0));
  return Buffer.concat([cipher.update(phone, 'utf8'), cipher.final()]).toString('hex').toUpperCase();
}
export function normalize(value) {
  if (typeof value === 'string' && /^[\[{]/.test(value.trim())) {
    try { return JSON.parse(value); } catch { /* leave ordinary strings intact */ }
  }
  return value;
}
export function objectsContaining(root, key) {
  const matches = [];
  function visit(value) {
    value = normalize(value);
    if (!value || typeof value !== 'object') return;
    if (!Array.isArray(value) && value[key] != null) matches.push(value);
    Object.values(value).forEach(visit);
  }
  visit(root);
  return matches;
}
function first(item, keys) {
  return keys.map(k => item[k]).find(v => v != null && String(v).trim() !== '');
}
function find(root, keys) {
  for (const key of keys) {
    const value = objectsContaining(root, key)[0]?.[key];
    if (value != null && String(value).trim()) return String(value);
  }
}
function numeric(value) {
  // Preserve IDs that JavaScript cannot represent exactly.
  return /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : value;
}
export async function boundedText(stream, max = 1024 * 1024) {
  if (!stream) return '';
  const reader = stream.getReader(); const chunks = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > max) { await reader.cancel(); throw new ApiError('响应或请求过大', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}
export class QinlinApi {
  constructor(env, deviceId, transport = defaultTransport, diagnostics) { this.env = env; this.deviceId = deviceId; this.transport = transport; this.diagnostics = diagnostics; }
  async request(url, body, contentType = 'application/json; charset=utf-8', headers = {}) {
    let response, stage = 'fetch';
    const endpoint = new URL(url), started = Date.now();
    const isOpen = endpoint.pathname.endsWith('/open/doorcontrol/v2/open');
    this.diagnostics?.protect(this.deviceId,...endpoint.searchParams.values());
    const target = {host:endpoint.host,path:endpoint.pathname};
    this.diagnostics?.add('upstream.start',{...target,stage});
    try {
      response = await this.transport(url, {
        method: 'POST', body, redirect: 'manual', signal: AbortSignal.timeout(8000),
        headers: { 'Content-Type': contentType, openid: this.deviceId,
          'User-Agent': 'Dart/3.8 (dart:io)', qversioncode: '3146', qchannel: 'google',
          qplatform: '0', qvendor: 'web', ...headers }
      });
      stage = 'read';
      this.diagnostics?.add('upstream.response',{...target,stage,upstreamStatus:response.status,contentType:response.headers.get('Content-Type'),elapsedMs:Date.now()-started});
      if (response.status >= 300 && response.status < 400) {
        throw new ApiError(`上游要求重定向（HTTP ${response.status}），已停止转发凭据`,502,{upstreamStatus:response.status,errorMessage:'Redirect refused; credentials not forwarded'});
      }
      if (!response.ok) throw new ApiError(`上游 HTTP ${response.status}，请求失败`, response.status === 401 ? 401 : 502, {upstreamStatus:response.status});
      const text = await boundedText(response.body);
      stage = 'parse';
      const bodyFormat = !text.trim() ? 'empty' : /^\s*</.test(text) ? 'html/xml' : /^[\s]*[\[{]/.test(text) ? 'json-like' : 'text';
      this.diagnostics?.add('upstream.body',{...target,stage,responseBytes:Buffer.byteLength(text),bodyFormat});
      let result;
      try { result = JSON.parse(text); }
      catch { throw new ApiError(`上游返回${bodyFormat === 'empty' ? '空响应' : '非 JSON 响应'}（HTTP ${response.status}）`,502,{errorName:'SyntaxError',errorMessage:'JSON.parse rejected upstream payload',bodyFormat}); }
      stage = 'validate';
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new ApiError('上游 JSON 格式不符合协议',502);
      const code = (typeof result.code === 'number' || (typeof result.code === 'string' && /^-?\d+$/.test(result.code))) ? Number(result.code) : NaN;
      if (result.success !== true && code !== 0 && !(code >= 200 && code <= 299)) {
        this.diagnostics?.add('upstream.rejected',{...target,stage,businessCode:Number.isFinite(code)?code:'missing',errorMessage:typeof result.message === 'string' ? result.message : 'No upstream message'});
        throw new ApiError(code === 401 ? '登录已失效，请重新登录' : `亲邻拒绝请求（code=${Number.isFinite(code)?code:'缺失'}），请查看诊断日志`, code === 401 ? 401 : 502,{upstreamStatus:response.status,businessCode:Number.isFinite(code)?code:null});
      }
      this.diagnostics?.add('upstream.success',{...target,elapsedMs:Date.now()-started});
      return normalize(result.data);
    } catch (error) {
      this.diagnostics?.add('upstream.error',{...target,stage,elapsedMs:Date.now()-started,...errorDetails(error),...(error instanceof ApiError ? error.details : {})});
      if (error instanceof ApiError) throw error;
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      const reason = timedOut ? '上游请求超时（8 秒）' : stage === 'fetch' ? '上游网络请求失败' : '上游响应读取失败';
      throw new ApiError(`${reason}，请查看诊断日志${isOpen ? '；开门结果未知，请现场确认' : ''}`);
    }
  }
  signed(endpoint, sessionId, fields, multipart = false) {
    const values = signFields(fields, sessionId, this.env.SIGNING_SALT);
    let body = JSON.stringify(values); let contentType;
    if (multipart) {
      const boundary = `qinlin-open-${nonce(12)}`;
      body = Object.entries(values).map(([k,v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('') + `--${boundary}--\r\n`;
      contentType = `multipart/form-data; boundary=${boundary}`;
    }
    return this.request(`https://mobileapi3.qinlinkeji.com/api/${endpoint}?${encodeQuery({sessionId})}`, body, contentType);
  }
  async sms(phone) {
    const timestamp = Date.now(), n = nonce(4);
    await this.request('https://gateway2.qinlinkeji.com/member/sms/sendSecurityCode', JSON.stringify({mobile: phone}), undefined,
      {appid: this.env.SMS_APP_ID, version: 'v2', timestamp: String(timestamp), nonce: n,
        sign: md5(`appid=${this.env.SMS_APP_ID}&mobile=${phone}&nonce=${n}&timestamp=${timestamp}&version=v2&appsecret=${this.env.SMS_APP_SECRET}`)});
  }
  async login(phone, code) {
    const data = await this.signed('app/v1/login', '', {mobile: encryptPhone(phone, this.env.HEX_AES_KEY), smsCode: code, appChannel: 1});
    const sessionId = find(data, ['sessionId', 'sessionID', 'token']);
    if (!sessionId || sessionId.length > 1024) throw new ApiError('登录响应缺少有效会话');
    return sessionId;
  }
  async doors(sessionId) {
    const root = await this.signed('app/user/v2/communityInfo', sessionId, {method: 'communityInfo'});
    const communities = new Map(objectsContaining(root, 'communityId').map(item => [String(item.communityId), item]));
    const doors = new Map();
    if (communities.size > 20) throw new ApiError('小区数量超过最小验证版限制');
    for (const [communityId, community] of communities) {
      const data = await this.signed('app/user/v2/queryUserDoorByCacheNew', sessionId, {communityId: numeric(communityId)}, true);
      for (const item of objectsContaining(data, 'doorControlId')) {
        const doorControlId = String(item.doorControlId);
        const stableId = `${communityId}:${doorControlId}`;
        doors.set(stableId, { stableId, communityId, doorControlId,
          communityName: String(first(item, ['communityName', 'projectName']) ?? first(community, ['communityName', 'name', 'communityShortName', 'projectName']) ?? ''),
          doorName: String(first(item, ['doorControlName', 'doorName', 'name', 'deviceName', 'remarkName']) ?? `钥匙 ${doorControlId}`) });
      }
    }
    return [...doors.values()];
  }
  async open(sessionId, key) {
    const values = signFields({appChannel: 1, doorControlId: numeric(key.doorControlId), communityId: numeric(key.communityId)}, sessionId, this.env.SIGNING_SALT);
    await this.request(`https://mobileapi3.qinlinkeji.com/api/open/doorcontrol/v2/open?${encodeQuery({sessionId, ...values})}`, '');
  }
}
