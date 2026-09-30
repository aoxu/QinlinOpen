import { randomUUID } from 'node:crypto';
import { ApiError, boundedText, defaultTransport, QinlinApi } from './protocol.js';
import { cookie, equalSecret, readSession, seal } from './session.js';
import { DiagnosticLog, errorDetails } from './diagnostics.js';

const securityHeaders = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};
function json(data, status = 200, setCookie) {
  const headers = { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' };
  if (setCookie) headers['Set-Cookie'] = setCookie;
  return new Response(JSON.stringify(data), { status, headers });
}
function configured(env) {
  return /^[a-f\d]{64}$/i.test(env.SESSION_KEY ?? '') && (env.ACCESS_PASSWORD?.length ?? 0) >= 16
    && /^1\d{10}$/.test(env.ALLOWED_PHONE ?? '') && /^[a-f\d]{32}$/i.test(env.HEX_AES_KEY ?? '')
    && env.SIGNING_SALT && env.SMS_APP_ID && env.SMS_APP_SECRET && env.API_LIMIT && env.SMS_LIMIT && env.OPEN_LIMIT;
}
const methods = { '/api/status': 'GET', '/api/unlock': 'POST', '/api/sms': 'POST', '/api/login': 'POST', '/api/doors': 'GET', '/api/open': 'POST', '/api/logout': 'POST' };
export function createWorker(transport = defaultTransport) {
  return { async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      const response = await env.ASSETS.fetch(request);
      const headers = new Headers(response.headers);
      Object.entries(securityHeaders).forEach(([k,v]) => headers.set(k,v));
      return new Response(response.body, { status: response.status, headers });
    }
    const requestId = randomUUID(), started = Date.now();
    const diagnostics = new DiagnosticLog(requestId,Object.values(env).filter(v=>typeof v==='string'));
    let session = configured(env) ? readSession(request, env.SESSION_KEY) : null;
    diagnostics.protect(session?.sessionId,session?.deviceId);
    diagnostics.add('api.start',{operation:url.pathname,colo:request.cf?.colo});
    const reply = (data, status = 200, setCookie) => {
      diagnostics.add('api.complete',{operation:url.pathname,status,elapsedMs:Date.now()-started});
      const result = json({...data,requestId,...(session?{diagnostics:diagnostics.snapshot()}: {})},status,setCookie);
      result.headers.set('X-Request-ID',requestId);
      return result;
    };
    if (!methods[url.pathname]) return reply({error: '接口不存在'}, 404);
    if (request.method !== methods[url.pathname]) return reply({error: '请求方法不允许'}, 405);
    if (url.search) return reply({error: 'API 不接受查询参数'}, 400);
    if (!configured(env)) return reply({error: '服务尚未配置完成，请检查 Secrets 与限流绑定'}, 503);
    try {
      if (request.method === 'POST') {
        if (request.headers.get('Origin') !== url.origin || request.headers.get('X-Qinlin-Request') !== '1') {
          throw new ApiError('请求来源不允许', 403);
        }
        if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new ApiError('仅接受 JSON 请求', 415);
      }
      const { success } = await env.API_LIMIT.limit({key: request.headers.get('CF-Connecting-IP') ?? 'local'});
      if (!success) throw new ApiError('操作过于频繁，请稍后再试', 429);
      if (url.pathname === '/api/status') return reply({ unlocked: Boolean(session), loggedIn: Boolean(session?.sessionId), openEnabled: env.OPEN_ENABLED === 'true' });
      let body = {};
      if (request.method === 'POST') {
        try { body = JSON.parse(await boundedText(request.body, 4096)); }
        catch { throw new ApiError('请求格式错误或过大', 400); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError('请求格式错误', 400);
        diagnostics.protect(body.password,body.phone,body.code,body.stableId);
      }
      if (url.pathname === '/api/unlock') {
        if (typeof body.password !== 'string' || !equalSecret(body.password, env.ACCESS_PASSWORD)) throw new ApiError('访问密码错误', 401);
        session = {deviceId: randomUUID().replaceAll('-', '').slice(0,16), exp: Date.now() + 1800000};
        return reply({ok: true}, 200, cookie(seal(session, env.SESSION_KEY)));
      }
      if (url.pathname === '/api/logout') return reply({ok: true}, 200, cookie('', 0));
      if (!session) throw new ApiError('请先解锁测试页面', 401);
      const api = new QinlinApi(env, session.deviceId, transport, diagnostics);
      if (url.pathname === '/api/sms' || url.pathname === '/api/login') {
        if (body.phone !== env.ALLOWED_PHONE) throw new ApiError('仅允许配置的测试手机号', 403);
        if (url.pathname === '/api/sms') {
          if (!(await env.SMS_LIMIT.limit({key: env.ALLOWED_PHONE})).success) throw new ApiError('验证码发送过于频繁，请稍后再试', 429);
          await api.sms(body.phone); return reply({ok: true});
        }
        if (typeof body.code !== 'string' || !/^\d{1,8}$/.test(body.code)) throw new ApiError('请输入有效验证码', 400);
        const sessionId = await api.login(body.phone, body.code);
        return reply({ok: true}, 200, cookie(seal({...session, sessionId, exp: Date.now() + 1800000}, env.SESSION_KEY)));
      }
      if (!session.sessionId) throw new ApiError('请先登录亲邻账号', 401);
      if (url.pathname === '/api/doors') return reply({doors: await api.doors(session.sessionId)});
      if (url.pathname === '/api/open') {
        if (env.OPEN_ENABLED !== 'true') throw new ApiError('当前仅验证登录和钥匙，真实开门尚未启用', 403);
        if (typeof body.stableId !== 'string' || body.stableId.length > 200 || body.confirm !== true) throw new ApiError('请明确确认指定钥匙', 400);
        if (!(await env.OPEN_LIMIT.limit({key: env.ALLOWED_PHONE})).success) throw new ApiError('请稍后再开门', 429);
        const key = (await api.doors(session.sessionId)).find(k => k.stableId === body.stableId);
        if (!key) throw new ApiError('钥匙不属于当前账号或已失效', 403);
        await api.open(session.sessionId, key);
        return reply({ok: true, message: '开门请求已被服务端接受，请现场确认门是否打开'});
      }
      return reply({error: '接口不存在'}, 404);
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 500;
      diagnostics.add('api.error',{operation:url.pathname,stage:'handler',...errorDetails(error)});
      return reply({error: error instanceof ApiError ? error.message : '服务异常，请查看诊断日志'}, status,
        status === 401 ? cookie('', 0) : undefined);
    }
  }};
}
export default createWorker();
