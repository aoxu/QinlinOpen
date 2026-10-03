import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { encodeQuery, encryptPhone, signFields, QinlinApi } from '../src/protocol.js';
import { seal, unseal, cookie } from '../src/session.js';
import { createWorker } from '../src/worker.js';
import { createLogBuffer, redact } from '../public/diagnostics.js';
import { copyText } from '../public/clipboard.js';
import { DoorPreferences } from '../src/preferences.js';
import { guardBinding } from './guard-binding.js';

function preferenceBinding() {
  const objects = new Map();
  return {idFromName:name=>name,get(name) {
    if (!objects.has(name)) {
      const values = new Map();
      objects.set(name,new DoorPreferences({storage:{get:async key=>structuredClone(values.get(key)),put:async(key,value)=>values.set(key,structuredClone(value))},blockConcurrencyWhile:task=>task()}));
    }
    return objects.get(name);
  }};
}

const key = '11'.repeat(32);
const env = {SESSION_KEY:key,ACCESS_PASSWORD:'test-password-long-enough',ALLOWED_PHONE:'13800000000',
  HEX_AES_KEY:'00'.repeat(16),SIGNING_SALT:'test-salt',SMS_APP_ID:'test-app',SMS_APP_SECRET:'test-secret',
  OPEN_ENABLED:'false',DOOR_PREFERENCES:preferenceBinding(),API_LIMIT:{limit:async()=>({success:true})},SMS_LIMIT:{limit:async()=>({success:true})},OPEN_LIMIT:{limit:async()=>({success:true})}};
env.UNLOCK_LIMIT = env.VERIFY_LIMIT = env.API_LIMIT;
env.TURNSTILE_SECRET = 'fake-secret'; env.TURNSTILE_SITEKEY = 'fake-sitekey'; env.TURNSTILE_HOSTNAMES = 'poc.example';
env.UNLOCK_GUARD = guardBinding(env);
const origin = 'https://poc.example';
const session = () => cookie(seal({deviceId:'0123456789abcdef',phone:env.ALLOWED_PHONE,sessionId:'fake-session',exp:Date.now()+60000},key));
function req(path, body, cookieValue, overrides = {}) {
  if (path === '/api/unlock' && body) body = {turnstileToken:'valid',...body};
  return new Request(origin+path,{method:body === undefined ? 'GET':'POST',
    headers:{Origin:origin,'Content-Type':'application/json','X-Qinlin-Request':'1',...(cookieValue?{Cookie:cookieValue}:{}),...overrides},
    body:body === undefined ? undefined:JSON.stringify(body)});
}
function upstream(data) { return new Response(JSON.stringify({success:true,data}),{headers:{'Content-Type':'application/json'}}); }

test('SMS relogin refreshes only an existing live account binding and preserves its credential and expiry',async()=>{
  const family={...env,OPEN_ENABLED:'true',ALLOWED_PHONES:'13800000000,13900000000',DOOR_PREFERENCES:preferenceBinding()};
  const used=[];
  const worker=createWorker(async url=>{
    if(url.includes('app/v1/login')) return upstream({sessionId:'new-login-session'});
    used.push(new URL(url).searchParams.get('sessionId'));
    if(url.includes('communityInfo')) return upstream([{communityId:1}]);
    if(url.includes('queryUserDoor')) return upstream([{doorControlId:2}]);
    return upstream({});
  });
  const call=(path,body)=>worker.fetch(req('/api/'+path,body,session()),family);
  await call('preferences',{stableId:'1:2',selected:true});
  const {token}=await (await call('shortcut/bind',{})).json();
  const store=family.DOOR_PREFERENCES.get(env.ALLOWED_PHONE);
  const read=async()=> (await store.fetch(new Request('https://internal/shortcut'))).json();
  const before=await read();
  assert.equal((await call('login',{phone:'13900000000',code:'123456'})).status,200);
  assert.deepEqual(await read(),before,'another account must not refresh this binding');
  assert.equal((await call('login',{phone:env.ALLOWED_PHONE,code:'123456'})).status,200);
  const after=await read();
  assert.equal(after.id,before.id); assert.equal(after.exp,before.exp);
  assert.equal(unseal(after.session,key).sessionId,'new-login-session');
  used.length=0;
  const response=await worker.fetch(new Request(origin+'/api/shortcut/open-selected',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}'}),family);
  assert.equal(response.status,200); assert.ok(used.every(v=>v==='new-login-session'));
  await call('shortcut/revoke',{});
  await call('login',{phone:env.ALLOWED_PHONE,code:'123456'});
  assert.equal(await read(),null);
  const expired={...before,exp:Date.now()-1};
  await store.fetch(new Request('https://internal/shortcut',{method:'POST',body:JSON.stringify(expired)}));
  await call('login',{phone:env.ALLOWED_PHONE,code:'123456'});
  assert.deepEqual(await read(),expired);
});

test('shortcut binding uses live selections, encrypted credentials, rotation and revocation without cookies',async()=>{
  const family={...env,OPEN_ENABLED:'true',DOOR_PREFERENCES:preferenceBinding()};
  const opened=[];
  const worker=createWorker(async url=>{
    if(url.includes('communityInfo')) return upstream([{communityId:1}]);
    if(url.includes('queryUserDoor')) return upstream([{doorControlId:2,doorName:'门 A'},{doorControlId:3,doorName:'门 B'}]);
    opened.push(new URL(url).searchParams.get('doorControlId')); return upstream({});
  });
  const call=(path,body)=>worker.fetch(req('/api/'+path,body,session()),family);
  const run=(token,body={action:'open-selected'})=>worker.fetch(new Request(origin+'/api/shortcut/open-selected',{
    method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)
  }),family);
  assert.equal((await call('shortcut/bind',{})).status,400);
  await call('preferences',{stableId:'1:2',selected:true});
  const binding=await (await call('shortcut/bind',{})).json();
  assert.ok(binding.token); assert.ok(!JSON.stringify(binding).includes('fake-session'));
  assert.equal(opened.length,0);
  const res=await run(binding.token);
  assert.equal(res.status,200); assert.equal(res.headers.has('Set-Cookie'),false);
  const data=await res.json(); assert.ok(!data.diagnostics); assert.match(data.message,/门 A/);
  await call('preferences',{stableId:'1:2',selected:false});
  await call('preferences',{stableId:'1:3',selected:true});
  assert.equal((await run(binding.token,{automatic:true,stableId:'1:2'})).status,200);
  assert.deepEqual(opened,['2','3']);
  const next=await (await call('shortcut/bind',{})).json();
  assert.equal((await run(binding.token)).status,401);
  assert.equal((await run(next.token)).status,200);
  await call('shortcut/revoke',{});
  const revoked=await run(next.token); assert.equal(revoked.status,401);
  assert.match((await revoked.json()).message,/撤销/);
  assert.equal((await (await call('shortcut/status')).json()).bound,false);
});

test('shortcut rejects wrong purpose, expired/tampered tokens, removed accounts and rate limits',async()=>{
  const family={...env,OPEN_ENABLED:'true',DOOR_PREFERENCES:preferenceBinding()};
  let openings=0;
  const worker=createWorker(async url=>{
    if(url.includes('communityInfo')) return upstream([{communityId:1}]);
    if(url.includes('queryUserDoor')) return upstream([{doorControlId:2}]);
    openings++; return upstream({});
  });
  const call=(path,body)=>worker.fetch(req('/api/'+path,body,session()),family);
  const run=(token,settings=family,method='POST')=>worker.fetch(new Request(origin+'/api/shortcut/open-selected',{
    method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(method==='POST'?{body:'{}'}:{})
  }),settings);
  await call('preferences',{stableId:'1:2',selected:true});
  const {token}=await (await call('shortcut/bind',{})).json();
  const decoded=unseal(token,key);
  for(const bad of ['bad',token.slice(0,-4)+'AAAA',seal({...decoded,exp:Date.now()-1},key),seal({...decoded,purpose:'web'},key),seal({...decoded,phone:'13900000000'},key)]) assert.equal((await run(bad)).status,401);
  assert.equal((await run(token,{...family,ALLOWED_PHONE:'13900000000'})).status,401);
  assert.equal((await run(token,{...family,OPEN_ENABLED:'false'})).status,403);
  assert.equal((await run(token,{...family,OPEN_LIMIT:{limit:async()=>({success:false})}})).status,429);
  assert.equal((await run(token,family,'GET')).status,405);
  assert.equal(openings,0);
  // A bearer credential is deliberately not a browser cookie and cannot manage bindings.
  assert.equal((await worker.fetch(req('/api/shortcut/revoke',{},undefined,{Authorization:'Bearer '+token}),family)).status,401);
});

test('upstream login expiry revokes shortcut and prevents repeated opening attempts',async()=>{
  const family={...env,OPEN_ENABLED:'true',DOOR_PREFERENCES:preferenceBinding()};
  let expired=false,calls=0;
  const worker=createWorker(async url=>{
    calls++;
    if(expired) return new Response('{}',{status:401});
    if(url.includes('communityInfo')) return upstream([{communityId:1}]);
    return upstream([{doorControlId:2}]);
  });
  await worker.fetch(req('/api/preferences',{stableId:'1:2',selected:true},session()),family);
  const {token}=await (await worker.fetch(req('/api/shortcut/bind',{},session()),family)).json();
  expired=true;
  const run=()=>worker.fetch(new Request(origin+'/api/shortcut/open-selected',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}'}),family);
  assert.equal((await run()).status,401);
  const before=calls;
  assert.equal((await run()).status,401); assert.equal(calls,before);
});

test('saved selections persist per account; batch starts all valid doors and retains partial failures',async()=>{
  const starts = []; let release;
  const gate = new Promise(resolve=>{release=resolve;});
  const family = {...env,ALLOWED_PHONES:'13800000000,13900000000',OPEN_ENABLED:'true',DOOR_PREFERENCES:preferenceBinding()};
  let limits=0; family.OPEN_LIMIT={limit:async()=>{limits++;return {success:true};}};
  const worker=createWorker(async url=>{
    if(url.includes('communityInfo')) return upstream([{communityId:1}]);
    if(url.includes('queryUserDoor')) return upstream([{doorControlId:2,doorName:'门 A'},{doorControlId:3,doorName:'门 B'}]);
    const id=new URL(url).searchParams.get('doorControlId'); starts.push(id);
    if(starts.length===2) release();
    await gate;
    return id==='3' ? Response.json({code:500}) : upstream({});
  });
  const call=async(path,body,auth=session())=>worker.fetch(req('/api/'+path,body,auth),family);
  assert.equal((await call('open-selected',{})).status,400);
  assert.equal((await call('preferences',{stableId:'1:999',selected:true})).status,403);
  for(const id of ['1:2','1:3']) assert.equal((await call('preferences',{stableId:id,selected:true})).status,200);
  assert.equal((await call('open-selected',{automatic:true})).status,403);
  await call('preferences',{autoOpen:true});
  assert.deepEqual((await (await call('doors')).json()).preferences,{selectedIds:['1:2','1:3'],autoOpen:true});
  const other=cookie(seal({deviceId:'other',phone:'13900000000',sessionId:'other-token',exp:Date.now()+60000},key));
  assert.deepEqual((await (await call('doors',undefined,other)).json()).preferences,{selectedIds:[],autoOpen:false});
  const result=await (await call('open-selected',{automatic:true})).json();
  assert.deepEqual(starts.sort(),['2','3']); assert.equal(limits,1);
  assert.deepEqual(result.results.map(r=>r.ok),[true,false]);
  await call('preferences',{stableId:'1:2',selected:false});
  assert.deepEqual((await (await call('doors')).json()).preferences.selectedIds,['1:3']);
});

test('batch respects disabled opening, rate limits and expired-key validation',async()=>{
  const binding=preferenceBinding();
  await binding.get(env.ALLOWED_PHONE).fetch(new Request('https://internal',{method:'POST',body:JSON.stringify({stableId:'1:2',selected:true})}));
  let openings=0;
  const worker=createWorker(async url=>{
    if(url.includes('communityInfo')) return upstream([{communityId:1}]);
    if(url.includes('queryUserDoor')) return upstream([{doorControlId:2}]);
    openings++; return upstream({});
  });
  const configured={...env,DOOR_PREFERENCES:binding};
  assert.equal((await worker.fetch(req('/api/open-selected',{},session()),configured)).status,403);
  assert.equal((await worker.fetch(req('/api/open-selected',{},session()),{...configured,OPEN_ENABLED:'true',OPEN_LIMIT:{limit:async()=>({success:false})}})).status,429);
  const noKeys=createWorker(async()=>upstream([]));
  assert.equal((await noKeys.fetch(req('/api/open-selected',{},session()),{...configured,OPEN_ENABLED:'true'})).status,403);
  assert.equal(openings,0);
});

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

test('SMS login renews access deadline and records successful login without leaking credentials',async()=>{
  const worker=createWorker(async()=>upstream({sessionId:'new-token'}));
  const exp=Date.now()+86400000; const access=cookie(seal({deviceId:'device',exp},key));
  const response=await worker.fetch(req('/api/login',{phone:env.ALLOWED_PHONE,code:'123456'},access),env);
  const value=unseal(response.headers.get('Set-Cookie').split(';')[0].split('=')[1],key);
  assert.ok(value.exp >= Date.now()+90*86400000-1000); assert.equal(value.phone,env.ALLOWED_PHONE); assert.equal(value.sessionId,'new-token');
  const data = await response.json();
  assert.equal(data.loginInfo.loggedInAt,value.loggedInAt); assert.equal(data.loginInfo.loginId,value.loginId);
  assert.ok(!JSON.stringify(data.loginInfo).includes('new-token')); assert.ok(!JSON.stringify(data.loginInfo).includes(env.ALLOWED_PHONE));
  assert.equal((await worker.fetch(req('/api/status'),{...env,ALLOWED_PHONES:'invalid'})).status,503);
});

test('login observations distinguish upstream rejection, access expiry, and network errors',async()=>{
  const loggedInAt=Date.now()-3600000;
  const c=cookie(seal({deviceId:'device',phone:env.ALLOWED_PHONE,sessionId:'token',loginId:'login-test',loggedInAt,exp:Date.now()+60000},key));
  const worker=createWorker(async()=>Response.json({code:401}));
  const response=await worker.fetch(req('/api/doors',undefined,c),env);
  const data=await response.json();
  assert.equal(data.loginInfo.reason,'upstream_unauthorized'); assert.equal(data.loginInfo.businessCode,401); assert.equal(data.loginInfo.upstreamStatus,200);
  assert.equal(data.loginInfo.loggedInAt,loggedInAt); assert.ok(data.loginInfo.detectedAt>=loggedInAt+3600000);
  const next=await (await worker.fetch(req('/api/status',undefined,response.headers.get('Set-Cookie')),env)).json();
  assert.equal(next.loginInfo.detectedAt,data.loginInfo.detectedAt);
  const expired=cookie(seal({deviceId:'device',loginId:'login-test',loggedInAt,exp:Date.now()-1},key));
  assert.equal((await (await worker.fetch(req('/api/status',undefined,expired),env)).json()).loginInfo.reason,'access_expired');
  const failing=createWorker(async()=>{throw new Error('network failure');});
  const failure=await (await failing.fetch(req('/api/doors',undefined,c),env)).json();
  assert.equal(failure.loginInfo.loggedIn,true); assert.equal(failure.loginInfo.reason,undefined);
});
