import { randomUUID } from 'node:crypto';
import { ApiError, boundedText, defaultTransport, QinlinApi } from './protocol.js';
import { cookie, readSession, seal } from './session.js';
import { unlockIdentity } from './unlock-guard.js';
import { DiagnosticLog, errorDetails } from './diagnostics.js';
export { DoorPreferences } from './preferences.js';
export { UnlockGuard } from './unlock-guard.js';

async function preferences(env, phone, update) {
  if (!env.DOOR_PREFERENCES) throw new ApiError('钥匙设置存储尚未配置', 503);
  const stub = env.DOOR_PREFERENCES.get(env.DOOR_PREFERENCES.idFromName(phone));
  const response = await stub.fetch(new Request('https://preferences.internal/', update === undefined ? {} : {
    method:'POST', body:JSON.stringify(update)
  }));
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.error || '设置保存失败', response.status);
  return data;
}

const securityHeaders = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self'; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};
function json(data, status = 200, setCookie) {
  const headers = { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' };
  if (setCookie) headers['Set-Cookie'] = setCookie;
  return new Response(JSON.stringify(data), { status, headers });
}
function configured(env) {
  return /^[a-f\d]{64}$/i.test(env.SESSION_KEY ?? '') && (env.ACCESS_PASSWORD?.length ?? 0) >= 16
    && allowedPhones(env).length > 0 && /^[a-f\d]{32}$/i.test(env.HEX_AES_KEY ?? '')
    && env.SIGNING_SALT && env.SMS_APP_ID && env.SMS_APP_SECRET && env.API_LIMIT && env.SMS_LIMIT && env.OPEN_LIMIT
    && env.UNLOCK_LIMIT && env.VERIFY_LIMIT && env.UNLOCK_GUARD && env.TURNSTILE_SECRET && env.TURNSTILE_SITEKEY && env.TURNSTILE_HOSTNAMES;
}
function allowedPhones(env) {
  const phones = (env.ALLOWED_PHONES ?? env.ALLOWED_PHONE ?? '').split(',').map(v=>v.trim());
  return phones.every(v=>/^1\d{10}$/.test(v)) ? [...new Set(phones)] : [];
}
const ACCESS_MS = 90 * 86400000;
const methods = { '/api/status': 'GET', '/api/unlock': 'POST', '/api/sms': 'POST', '/api/login': 'POST', '/api/doors': 'GET', '/api/open': 'POST', '/api/logout': 'POST', '/api/preferences':'POST', '/api/open-selected':'POST' };
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
    let stored = configured(env) ? readSession(request, env.SESSION_KEY, true) : null;
    if (stored?.phone && !allowedPhones(env).includes(stored.phone)) stored = null;
    // Legacy cookies have no account binding; require a fresh SMS login once.
    if (stored?.sessionId && !stored.phone) stored = {...stored,sessionId:undefined};
    let session = stored?.exp > Date.now() ? stored : null, checkingUpstreamSession = false;
    diagnostics.protect(stored?.sessionId,stored?.deviceId,stored?.phone);
    diagnostics.add('api.start',{operation:url.pathname,colo:request.cf?.colo});
    const reply = (data, status = 200, setCookie) => {
      diagnostics.add('api.complete',{operation:url.pathname,status,elapsedMs:Date.now()-started});
      const refreshedCookie = status < 400 && stored ? cookie(seal(stored,env.SESSION_KEY)) : undefined;
      const result = json({...data,requestId,...(session?{diagnostics:diagnostics.snapshot()}: {})},status,setCookie ?? refreshedCookie);
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
      const rateKey = session?.phone ? `account:${session.phone}` : `ip:${request.headers.get('CF-Connecting-IP') ?? 'local'}`;
      const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
      if (url.pathname === '/api/unlock' && !(await env.UNLOCK_LIMIT.limit({key:`unlock:${ip}`})).success) {
        const result = reply({error:'访问验证过于频繁，请 60 秒后再试',retryAfter:60},429);
        result.headers.set('Retry-After','60'); return result;
      }
      const { success } = await env.API_LIMIT.limit({key: rateKey});
      if (!success) throw new ApiError('操作过于频繁，请稍后再试', 429);
      if (url.pathname === '/api/status') return reply({ unlocked: Boolean(session), loggedIn: Boolean(session?.sessionId), openEnabled: env.OPEN_ENABLED === 'true', ...(!session ? {turnstileSitekey:env.TURNSTILE_SITEKEY} : {}) });
      let body = {};
      if (request.method === 'POST') {
        try { body = JSON.parse(await boundedText(request.body, 4096)); }
        catch { throw new ApiError('请求格式错误或过大', 400); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError('请求格式错误', 400);
        diagnostics.protect(body.password,body.phone,body.code,body.stableId,body.turnstileToken);
      }
      if (url.pathname === '/api/unlock') {
        if (typeof body.password !== 'string' || body.password.length > 1024) throw new ApiError('访问密码格式错误',400);
        if (typeof body.turnstileToken !== 'string' || !body.turnstileToken || body.turnstileToken.length > 2048) throw new ApiError('请先完成安全验证',403);
        if (!(await env.VERIFY_LIMIT.limit({key:'qinlin-unlock-verifications'})).success) {
          const result = reply({error:'安全验证繁忙，请 60 秒后再试',retryAfter:60},429);
          result.headers.set('Retry-After','60'); return result;
        }
        const identity = unlockIdentity(ip,env.SESSION_KEY);
        const guard = env.UNLOCK_GUARD.get(env.UNLOCK_GUARD.idFromName(identity));
        const validation = await guard.fetch(new Request('https://unlock.internal/',{method:'POST',body:JSON.stringify({password:body.password,token:body.turnstileToken,ip})}));
        if (!validation.ok) {
          const data = await validation.json();
          const result = reply(data,validation.status);
          if (data.retryAfter) result.headers.set('Retry-After',String(data.retryAfter));
          return result;
        }
        session = {...stored,deviceId: stored?.deviceId ?? randomUUID().replaceAll('-', '').slice(0,16), exp: Date.now() + ACCESS_MS};
        stored = session;
        return reply({ok: true}, 200, cookie(seal(session, env.SESSION_KEY)));
      }
      if (url.pathname === '/api/logout') return reply({ok: true}, 200, cookie('', 0));
      if (!session) throw new ApiError('请先解锁测试页面', 401);
      const api = new QinlinApi(env, session.deviceId, transport, diagnostics);
      if (url.pathname === '/api/sms' || url.pathname === '/api/login') {
        if (!allowedPhones(env).includes(body.phone)) throw new ApiError('该手机号未加入家庭白名单', 403);
        if (url.pathname === '/api/sms') {
          if (!(await env.SMS_LIMIT.limit({key: body.phone})).success) throw new ApiError('验证码发送过于频繁，请稍后再试', 429);
          await api.sms(body.phone); return reply({ok: true});
        }
        if (typeof body.code !== 'string' || !/^\d{1,8}$/.test(body.code)) throw new ApiError('请输入有效验证码', 400);
        const sessionId = await api.login(body.phone, body.code);
        session = stored = {...session, phone:body.phone, sessionId};
        return reply({ok: true}, 200, cookie(seal(session, env.SESSION_KEY)));
      }
      if (!session.sessionId) throw new ApiError('请先登录亲邻账号', 401);
      if (url.pathname === '/api/preferences') {
        const selection = typeof body.stableId === 'string' && body.stableId.length > 0 && body.stableId.length <= 200 && typeof body.selected === 'boolean';
        const toggle = typeof body.autoOpen === 'boolean';
        if (!selection && !toggle) throw new ApiError('设置格式错误',400);
        if (selection && body.selected) {
          checkingUpstreamSession = true;
          if (!(await api.doors(session.sessionId)).some(k=>k.stableId === body.stableId)) throw new ApiError('钥匙不属于当前账号或已失效',403);
        }
        return reply({preferences:await preferences(env,session.phone,{
          ...(selection ? {stableId:body.stableId,selected:body.selected} : {}), ...(toggle ? {autoOpen:body.autoOpen} : {})
        })});
      }
      checkingUpstreamSession = true;
      if (url.pathname === '/api/doors') return reply({doors: await api.doors(session.sessionId), preferences:await preferences(env,session.phone)});
      if (url.pathname === '/api/open-selected') {
        if (env.OPEN_ENABLED !== 'true') throw new ApiError('真实开门尚未启用',403);
        const saved = await preferences(env,session.phone);
        if (body.automatic === true && !saved.autoOpen) throw new ApiError('自动开门已关闭',403);
        if (!saved.selectedIds.length) throw new ApiError('请先勾选要开启的门',400);
        const keys = await api.doors(session.sessionId);
        const selected = saved.selectedIds.map(id=>({id,key:keys.find(k=>k.stableId===id)}));
        if (!selected.some(item=>item.key)) throw new ApiError('已选钥匙均已失效，请重新选择',403);
        if (!(await env.OPEN_LIMIT.limit({key:session.phone})).success) throw new ApiError('请稍后再开门',429);
        let loginExpired = false;
        const results = await Promise.all(selected.map(async ({id,key})=>{
          if (!key) return {stableId:id,ok:false,message:'钥匙已失效或不属于当前账号'};
          try { await api.open(session.sessionId,key); return {stableId:id,doorName:key.doorName,ok:true,message:'请求已接受，请现场确认'}; }
          catch(error) {
            if (error instanceof ApiError && error.status===401) loginExpired = true;
            return {stableId:id,doorName:key.doorName,ok:false,message:error instanceof ApiError ? error.message : '开门结果未知，请现场确认'};
          }
        }));
        if (loginExpired) session = stored = {...session,sessionId:undefined};
        return reply({results,loggedIn:!loginExpired});
      }
      if (url.pathname === '/api/open') {
        if (env.OPEN_ENABLED !== 'true') throw new ApiError('当前仅验证登录和钥匙，真实开门尚未启用', 403);
        if (typeof body.stableId !== 'string' || !body.stableId || body.stableId.length > 200) throw new ApiError('请选择有效钥匙', 400);
        if (!(await env.OPEN_LIMIT.limit({key: session.phone})).success) throw new ApiError('请稍后再开门', 429);
        const key = (await api.doors(session.sessionId)).find(k => k.stableId === body.stableId);
        if (!key) throw new ApiError('钥匙不属于当前账号或已失效', 403);
        await api.open(session.sessionId, key);
        return reply({ok: true, message: '开门请求已被服务端接受，请现场确认门是否打开'});
      }
      return reply({error: '接口不存在'}, 404);
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 500;
      diagnostics.add('api.error',{operation:url.pathname,stage:'handler',...errorDetails(error)});
      let setCookie;
      if (status === 401 && checkingUpstreamSession && session?.sessionId) {
        session = stored = {...session,sessionId:undefined};
        setCookie = cookie(seal(stored,env.SESSION_KEY));
      }
      return reply({error: error instanceof ApiError ? error.message : '服务异常，请查看诊断日志',
        ...(status === 401 ? {unlocked:Boolean(session),loggedIn:false,...(!session ? {turnstileSitekey:env.TURNSTILE_SITEKEY} : {})} : {})}, status, setCookie);
    }
  }};
}
export default createWorker();
