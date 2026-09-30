import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { encodeQuery, encryptPhone, signFields, QinlinApi } from '../src/protocol.js';
import { seal, unseal, cookie } from '../src/session.js';
import { createWorker } from '../src/worker.js';

const key = '11'.repeat(32);
const env = {SESSION_KEY:key,ACCESS_PASSWORD:'test-password-long-enough',ALLOWED_PHONE:'13800000000',
  HEX_AES_KEY:'00'.repeat(16),SIGNING_SALT:'test-salt',SMS_APP_ID:'test-app',SMS_APP_SECRET:'test-secret',
  OPEN_ENABLED:'false',API_LIMIT:{limit:async()=>({success:true})},SMS_LIMIT:{limit:async()=>({success:true})},OPEN_LIMIT:{limit:async()=>({success:true})}};
const origin = 'https://poc.example';
const session = () => cookie(seal({deviceId:'0123456789abcdef',sessionId:'fake-session',exp:Date.now()+60000},key));
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
  assert.deepEqual(await res.json(),{ok:true});
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
  const res = await worker.fetch(req('/api/open',{stableId:'1:2',confirm:true},session()),{...env,OPEN_ENABLED:'true'});
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
test('upstream 401 clears browser cookie',async()=>{
  const worker = createWorker(async()=>new Response(JSON.stringify({code:401}),{status:200}));
  const res = await worker.fetch(req('/api/doors',undefined,session()),env);
  assert.equal(res.status,401); assert.match(res.headers.get('Set-Cookie'),/Max-Age=0/);
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
