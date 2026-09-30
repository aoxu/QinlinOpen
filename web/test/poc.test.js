import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { encodeQuery, encryptPhone, signFields, QinlinApi } from '../src/protocol.js';
import { seal, unseal, cookie } from '../src/session.js';
import { createWorker } from '../src/worker.js';
import { createLogBuffer, redact } from '../public/diagnostics.js';
import { copyText } from '../public/clipboard.js';

const key = '11'.repeat(32);
const env = {SESSION_KEY:key,ACCESS_PASSWORD:'test-password-long-enough',ALLOWED_PHONE:'13800000000',
  HEX_AES_KEY:'00'.repeat(16),SIGNING_SALT:'test-salt',SMS_APP_ID:'test-app',SMS_APP_SECRET:'test-secret',
  OPEN_ENABLED:'false',API_LIMIT:{limit:async()=>({success:true})},SMS_LIMIT:{limit:async()=>({success:true})},OPEN_LIMIT:{limit:async()=>({success:true})}};
const origin = 'https://poc.example';
const session = () => cookie(seal({deviceId:'0123456789abcdef',phone:env.ALLOWED_PHONE,sessionId:'fake-session',exp:Date.now()+60000},key));
function req(path, body, cookieValue, overrides = {}) {
  return new Request(origin+path,{method:body === undefined ? 'GET':'POST',
    headers:{Origin:origin,'Content-Type':'application/json','X-Qinlin-Request':'1',...(cookieValue?{Cookie:cookieValue}:{}),...overrides},
    body:body === undefined ? undefined:JSON.stringify(body)});
}
function upstream(data) { return new Response(JSON.stringify({success:true,data}),{headers:{'Content-Type':'application/json'}}); }

test('Java form encoding preserves colon, encodes special characters and sorts fields',()=>{
  assert.equal(encodeQuery({z:'a b:c+!',a:"~*'()"}), 'a=%7E*%27%28%29&z=a+b:c%2B%21');
});
test('signature canonical string matches Kotlin field ordering and upper-case digest',()=>{
  const canonical = 'appChannel=1&communityId=1&doorControlId=2&nonce=00001&timestamp=1700000000000&token=abc:def&version=5.2.6&key=test-salt';
  const expected = createHash('md5').update(canonical).digest('hex').toUpperCase();
  assert.equal(signFields({doorControlId:2,communityId:1,appChannel:1},'abc:def','test-salt',1700000000000,'00001').sign,expected);
});
test('AES phone encryption matches Node reference with PKCS padding',()=>{
  const cipher = createCipheriv('aes-128-ecb',Buffer.alloc(16),null);
  const expected = Buffer.concat([cipher.update('13800000000'),cipher.final()]).toString('hex').toUpperCase();
  assert.equal(encryptPhone('13800000000','00'.repeat(16)),expected);
});
test('cookie encryption rejects tampering and expiry; does not expose session text',()=>{
  const value = seal({sessionId:'hidden-value',exp:2000},key);
  assert.equal(unseal(value,key,1000).sessionId,'hidden-value');
  assert.equal(unseal(value,key,2000),null);
  const altered = Buffer.from(value,'base64url'); altered[30] ^= 1;
  assert.equal(unseal(altered.toString('base64url'),key,1000),null);
  assert.ok(!Buffer.from(value,'base64url').toString().includes('hidden-value'));
  assert.match(cookie(value),/Secure; HttpOnly; SameSite=Strict/);
});
test('fails closed when secrets or rate bindings are missing',async()=>{
  const res = await createWorker().fetch(req('/api/status'),{}); assert.equal(res.status,503);
});
test('cross-origin requests and wrong methods are rejected before upstream calls',async()=>{
  const worker = createWorker(()=>{throw new Error('must not fetch');});
  assert.equal((await worker.fetch(req('/api/sms',{phone:env.ALLOWED_PHONE},session(),{Origin:'https://evil.example'}),env)).status,403);
  assert.equal((await worker.fetch(req('/api/open'),env)).status,405);
});
test('anonymous requests and non-allowlisted phones cannot call upstream',async()=>{
  const worker = createWorker(()=>{throw new Error('must not fetch');});
  assert.equal((await worker.fetch(req('/api/doors'),env)).status,401);
  assert.equal((await worker.fetch(req('/api/sms',{phone:'13900000000'},session()),env)).status,403);
});
test('unlock issues encrypted cookie without disclosing credentials',async()=>{
  const res = await createWorker().fetch(req('/api/unlock',{password:env.ACCESS_PASSWORD}),env);
  assert.equal(res.status,200); assert.match(res.headers.get('Set-Cookie'),/HttpOnly/);
  const data = await res.json();
  assert.equal(data.ok,true); assert.match(data.requestId,/^[a-f\d-]{36}$/);
  assert.ok(!JSON.stringify(data).includes(env.ACCESS_PASSWORD));
});
test('SMS and API rate limiter rejection prevents network requests',async()=>{
  const worker = createWorker(()=>{throw new Error('must not fetch');});
  const blocked = {limit:async()=>({success:false})};
  assert.equal((await worker.fetch(req('/api/sms',{phone:env.ALLOWED_PHONE},session()),{...env,SMS_LIMIT:blocked})).status,429);
  assert.equal((await worker.fetch(req('/api/status'),{...env,API_LIMIT:blocked})).status,429);
});
test('open disabled by default and unknown keys rejected when enabled',async()=>{
  let calls = 0;
  const worker = createWorker(async()=>{calls++;return upstream([]);});
  assert.equal((await worker.fetch(req('/api/open',{stableId:'1:2',confirm:true},session()),env)).status,403);
  assert.equal(calls,0);
  assert.equal((await worker.fetch(req('/api/open',{stableId:'1:2',confirm:true},session()),{...env,OPEN_ENABLED:'true'})).status,403);
  assert.equal(calls,1);
});
test('authorized open checks current keys, posts exactly once, and reports request acceptance',async()=>{
  const calls = [];
  const worker = createWorker(async(url,options)=>{
    calls.push({url,options});
    if(url.includes('communityInfo')) return upstream([{communityId:1,communityName:'测试小区'}]);
    if(url.includes('queryUserDoor')) return upstream([{doorControlId:2,doorName:'测试门'}]);
    return upstream({});
  });
  const res = await worker.fetch(req('/api/open',{stableId:'1:2'},session()),{...env,OPEN_ENABLED:'true'});
  assert.equal(res.status,200); assert.match((await res.json()).message,/现场确认/);
  const opening = calls.filter(c=>c.url.includes('/open/doorcontrol/')); assert.equal(opening.length,1);
  assert.equal(opening[0].options.method,'POST'); assert.equal(opening[0].options.body,'');
  assert.match(calls[1].options.headers['Content-Type'],/multipart\/form-data/);
  assert.match(calls[1].options.body,/name="communityId"\r\n\r\n1/);
});
test('timeout does not retry and never includes upstream URL or session in errors',async()=>{
  let calls = 0;
  const api = new QinlinApi(env,'fake-device',async()=>{calls++;throw new Error('URL fake-session');});
  await assert.rejects(api.open('fake-session',{communityId:'1',doorControlId:'2'}),error=>error.message.includes('结果未知')&&!error.message.includes('fake-session'));
  assert.equal(calls,1);
});
test('upstream 401 clears upstream login but retains access password approval',async()=>{
  const worker = createWorker(async()=>new Response(JSON.stringify({code:401}),{status:200}));
  const res = await worker.fetch(req('/api/doors',undefined,session()),env);
  assert.equal(res.status,401);
  const restored = unseal(res.headers.get('Set-Cookie').split(';')[0].split('=')[1],key);
  assert.equal(restored.sessionId,undefined); assert.equal(restored.phone,env.ALLOWED_PHONE);
  assert.equal((await res.json()).unlocked,true);
});
test('null or missing upstream code does not become a false success',async()=>{
  for (const code of [null,undefined,'']) {
    const api = new QinlinApi(env,'fake',async()=>Response.json({code,data:{}}));
    await assert.rejects(api.doors('fake'),error=>error.status===502);
  }
});
test('oversized request and upstream data are rejected',async()=>{
  assert.equal((await createWorker().fetch(req('/api/unlock',{password:'a'.repeat(5000)}),env)).status,400);
  const api = new QinlinApi(env,'fake',async()=>new Response('x'.repeat(1024*1024+1)));
  await assert.rejects(api.doors('fake'),error=>error.status===413);
});
test('network failure includes safe cause and fetch stage, without SMS/open confusion',async()=>{
  const worker = createWorker(async()=>{throw new TypeError(`fetch failed https://example.com/sms?sessionId=fake-session mobile=${env.ALLOWED_PHONE} code=123456`,{cause:new Error('DNS resolution failed')});});
  const res = await worker.fetch(req('/api/sms',{phone:env.ALLOWED_PHONE},session()),env);
  const data = await res.json();
  assert.equal(res.status,502); assert.match(data.error,/网络请求失败/); assert.ok(!data.error.includes('开门'));
  const detail = data.diagnostics.find(e=>e.event==='upstream.error');
  assert.equal(detail.stage,'fetch'); assert.equal(detail.errorName,'TypeError'); assert.equal(detail.causeMessage,'DNS resolution failed');
  const text = JSON.stringify(data);
  for(const secret of [env.ALLOWED_PHONE,'fake-session','123456']) assert.ok(!text.includes(secret));
  assert.ok(!detail.path.includes('?'));
});
test('SMS timeout explicitly names timeout and does not retry',async()=>{
  let calls=0;
  const worker=createWorker(async()=>{calls++;throw new DOMException('The operation timed out','TimeoutError');});
  const res=await worker.fetch(req('/api/sms',{phone:env.ALLOWED_PHONE},session()),env);
  const data=await res.json(); assert.match(data.error,/超时/); assert.equal(calls,1);
  assert.equal(data.diagnostics.find(e=>e.event==='upstream.error').errorName,'TimeoutError');
});
test('HTML, empty, HTTP errors and business rejections have distinct diagnostics',async()=>{
  for(const [response,expected,event] of [
    [new Response('<html>private 13800000000 fake-session</html>',{headers:{'Content-Type':'text/html'}}),'非 JSON','upstream.body'],
    [new Response(''),'空响应','upstream.body'],
    [new Response('private fake-session',{status:403}),'HTTP 403','upstream.error'],
    [Response.json({success:false,code:500,message:'mobile=13800000000 token=fake-session captcha required'}),'code=500','upstream.rejected']
  ]) {
    const worker=createWorker(async()=>response);
    const data=await (await worker.fetch(req('/api/sms',{phone:env.ALLOWED_PHONE},session()),env)).json();
    assert.ok(data.error.includes(expected)); assert.ok(data.diagnostics.some(e=>e.event===event));
    assert.ok(!JSON.stringify(data).includes('fake-session')); assert.ok(!JSON.stringify(data).includes('13800000000'));
    assert.ok(!JSON.stringify(data).includes('<html>'));
  }
});
test('recent log buffer caps entries, drops payloads, masks secrets and exports safe JSON',()=>{
  const logs=createLogBuffer(2);
  logs.append({event:'first',body:'do not retain',headers:{cookie:'secret'}});
  logs.append({event:'second',errorMessage:'phone=13800000000 code=123456 https://a.example/x?sessionId=private',payload:'secret'});
  logs.append({event:'third',errorMessage:'password private-pass'},['private-pass']);
  const exported=JSON.parse(logs.export()); assert.equal(exported.logs.length,2);
  assert.equal(exported.logs[0].event,'second');
  for(const value of ['13800000000','123456','private-pass','sessionId=private','payload']) assert.ok(!logs.export().includes(value));
  logs.clear(); assert.equal(logs.snapshot().length,0);
});
test('clipboard denial falls back to selection and reports manual-copy failure',async()=>{
  let selected=false,removed=false;
  const page={createElement:()=>({setAttribute(){},select(){selected=true;},remove(){removed=true;}}),body:{append(){}},execCommand:()=>true};
  assert.equal(await copyText('safe logs',{clipboard:{writeText:async()=>{throw new Error('denied');}}},page),true);
  assert.ok(selected&&removed);
  assert.equal(await copyText('safe logs',{}, {...page,execCommand:()=>false}),false);
});
test('Workers-compatible manual redirects stop rather than forwarding credentials',async()=>{
  let calls=0;
  const api=new QinlinApi(env,'fake',async(url,options)=>{
    calls++; assert.equal(options.redirect,'manual');
    return new Response(null,{status:302,headers:{Location:'https://other.example/?token=fake-session'}});
  });
  await assert.rejects(api.sms(env.ALLOWED_PHONE),error=>error.message.includes('重定向'));
  assert.equal(calls,1);
});

test('90-day access deadline is fixed; expired access preserves login upon password unlock',async()=>{
  const worker = createWorker(()=>{throw new Error('must not fetch');});
  const old = {deviceId:'old-device',phone:env.ALLOWED_PHONE,sessionId:'old-token',exp:Date.now()-1};
  const oldCookie = cookie(seal(old,key));
  assert.equal((await (await worker.fetch(req('/api/status',undefined,oldCookie),env)).json()).loggedIn,false);
  assert.equal((await worker.fetch(req('/api/doors',undefined,oldCookie),env)).status,401);
  const before=Date.now();
  const response=await worker.fetch(req('/api/unlock',{password:env.ACCESS_PASSWORD},oldCookie),env);
  const restored=unseal(response.headers.get('Set-Cookie').split(';')[0].split('=')[1],key);
  assert.equal(restored.sessionId,'old-token'); assert.equal(restored.deviceId,'old-device');
  assert.ok(restored.exp >= before+90*86400000 && restored.exp <= Date.now()+90*86400000);
  const status=await worker.fetch(req('/api/status',undefined,response.headers.get('Set-Cookie')),env);
  assert.equal((await status.json()).loggedIn,true);
  assert.equal(unseal(status.headers.get('Set-Cookie').split(';')[0].split('=')[1],key).exp,restored.exp);
});

test('family accounts isolate tokens and rate limits; same account devices share opening limit',async()=>{
  const phones=['13800000000','13900000000']; const limits={sms:[],api:[],open:[]}; const seen=new Set(); const tokens=[];
  const family={...env,ALLOWED_PHONES:phones.join(','),OPEN_ENABLED:'true',
    API_LIMIT:{limit:async({key})=>{limits.api.push(key);return {success:true};}},
    SMS_LIMIT:{limit:async({key})=>{limits.sms.push(key);return {success:true};}},
    OPEN_LIMIT:{limit:async({key})=>{limits.open.push(key);const success=!seen.has(key);seen.add(key);return {success};}}};
  const worker=createWorker(async(url)=>{
    if(url.includes('sendSecurityCode')) return upstream({});
    tokens.push(new URL(url).searchParams.get('sessionId'));
    if(url.includes('communityInfo')) return upstream([{communityId:1}]);
    if(url.includes('queryUserDoor')) return upstream([{doorControlId:2}]);
    return upstream({});
  });
  const device=(phone,id)=>cookie(seal({deviceId:id,phone,sessionId:`token-${phone}`,exp:Date.now()+86400000},key));
  for(const phone of phones){
    assert.equal((await worker.fetch(req('/api/sms',{phone},device(phone,'device-a')),family)).status,200);
    assert.equal((await worker.fetch(req('/api/open',{stableId:'1:2'},device(phone,'device-a')),family)).status,200);
  }
  assert.equal((await worker.fetch(req('/api/open',{stableId:'1:2'},device(phones[0],'device-b')),family)).status,429);
  assert.deepEqual(limits.sms,phones); assert.deepEqual(limits.open,[...phones,phones[0]]);
  assert.ok(limits.api.includes(`account:${phones[1]}`));
  assert.ok(tokens.includes(`token-${phones[0]}`)&&tokens.includes(`token-${phones[1]}`));
  const removed={...family,ALLOWED_PHONES:phones[0]};
  assert.equal((await worker.fetch(req('/api/doors',undefined,device(phones[1],'device-a')),removed)).status,401);
});

test('SMS login preserves password deadline and binds selected phone; malformed allowlist fails closed',async()=>{
  const worker=createWorker(async()=>upstream({sessionId:'new-token'}));
  const exp=Date.now()+86400000; const access=cookie(seal({deviceId:'device',exp},key));
  const response=await worker.fetch(req('/api/login',{phone:env.ALLOWED_PHONE,code:'123456'},access),env);
  const value=unseal(response.headers.get('Set-Cookie').split(';')[0].split('=')[1],key);
  assert.equal(value.exp,exp); assert.equal(value.phone,env.ALLOWED_PHONE); assert.equal(value.sessionId,'new-token');
  assert.equal((await worker.fetch(req('/api/status'),{...env,ALLOWED_PHONES:'invalid'})).status,503);
});
