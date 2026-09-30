import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import assert from 'node:assert/strict';

// Build the real Worker into workerd; replace only upstream I/O and rate-limit bindings.
const result = await build({stdin:{contents:`
import { createWorker } from './src/worker.js';
export { DoorPreferences } from './src/preferences.js';
export { UnlockGuard } from './src/unlock-guard.js';
const worker = createWorker();
export default {fetch(request, env) {
  const limit = {limit:async()=>({success:true})};
  return worker.fetch(request,{
    SESSION_KEY:'11'.repeat(32),ACCESS_PASSWORD:'runtime-test-password-long',ALLOWED_PHONE:'13800000000',
    HEX_AES_KEY:'00'.repeat(16),SIGNING_SALT:'fake',SMS_APP_ID:'fake',SMS_APP_SECRET:'fake',
    OPEN_ENABLED:'true',DOOR_PREFERENCES:env.DOOR_PREFERENCES,UNLOCK_GUARD:env.UNLOCK_GUARD,API_LIMIT:limit,SMS_LIMIT:limit,OPEN_LIMIT:limit,
    UNLOCK_LIMIT:limit,VERIFY_LIMIT:limit,TURNSTILE_SECRET:'fake-secret',TURNSTILE_SITEKEY:'fake-sitekey',TURNSTILE_HOSTNAMES:'runtime.example'
  });
}};
`,resolveDir:process.cwd(),sourcefile:'runtime-entry.js'},bundle:true,write:false,format:'esm',platform:'node',target:'es2022',external:['node:*']});
let outgoing = [];
const verifiedTokens = new Set();
const mf = new Miniflare({workers:[{
  config:{name:'poc-test',compatibilityDate:'2026-09-30',compatibilityFlags:['nodejs_compat'],env:{
    ACCESS_PASSWORD:{type:'text',value:'runtime-test-password-long'},TURNSTILE_SECRET:{type:'text',value:'fake-secret'},TURNSTILE_HOSTNAMES:{type:'text',value:'runtime.example'},
    DOOR_PREFERENCES:{type:'durable-object',worker:'poc-test',exportName:'DoorPreferences'},UNLOCK_GUARD:{type:'durable-object',worker:'poc-test',exportName:'UnlockGuard'}
  },exports:{DoorPreferences:{type:'durable-object',storage:'sqlite'},UnlockGuard:{type:'durable-object',storage:'sqlite'}},manifest:{mainModule:'worker.js',modules:{'worker.js':{type:'esm',contents:result.outputFiles[0].text}}}},
  dev:{outboundService:{type:'fetcher',handler:async(request)=>{
    const url=new URL(request.url); outgoing.push(url.pathname);
    if (url.hostname === 'challenges.cloudflare.com') {
      const token=(await request.formData()).get('response');
      const success=token === 'runtime-token' && !verifiedTokens.has(token);
      verifiedTokens.add(token);
      return Response.json({success,action:'unlock',hostname:'runtime.example'});
    }
    let data={};
    if(url.pathname.includes('app/v1/login')) data={sessionId:'runtime-fake-session'};
    if(url.pathname.includes('communityInfo')) data=[{communityId:1,communityName:'测试小区'}];
    if(url.pathname.includes('queryUserDoor')) data=[{doorControlId:2,doorName:'测试门'}];
    return Response.json({success:true,data});
  }}}
}]});
let storedCookie;
async function call(path,body) {
  const response = await mf.dispatchFetch('https://runtime.example/api/'+path,{
    method:body === undefined ? 'GET':'POST',headers:{Origin:'https://runtime.example','Content-Type':'application/json','X-Qinlin-Request':'1',...(storedCookie?{Cookie:storedCookie}:{})},
    body:body === undefined ? undefined:JSON.stringify(body)
  });
  if(response.headers.has('Set-Cookie')) storedCookie = response.headers.get('Set-Cookie').split(';')[0];
  assert.equal(response.status,200,await response.clone().text());
  return response.json();
}
try {
  await call('unlock',{password:'runtime-test-password-long',turnstileToken:'runtime-token'});
  await call('sms',{phone:'13800000000'});
  await call('login',{phone:'13800000000',code:'123456'});
  assert.equal((await call('status')).loggedIn,true);
  assert.equal((await call('doors')).doors[0].stableId,'1:2');
  assert.match((await call('open',{stableId:'1:2'})).message,/现场确认/);
  assert.deepEqual((await call('doors')).preferences,{selectedIds:[],autoOpen:false});
  await call('preferences',{stableId:'1:2',selected:true});
  await call('preferences',{autoOpen:true});
  assert.deepEqual((await call('doors')).preferences,{selectedIds:['1:2'],autoOpen:true});
  assert.equal((await call('open-selected',{automatic:true})).results[0].ok,true);
  await call('logout',{});
  assert.equal((await call('status')).loggedIn,false);
  assert.ok(outgoing.includes('/member/sms/sendSecurityCode'));
  assert.equal(outgoing.filter(p=>p.includes('/open/doorcontrol/')).length,2);
  async function rejectedUnlock(token,expectedStatus) {
    const response=await mf.dispatchFetch('https://runtime.example/api/unlock',{
      method:'POST',headers:{Origin:'https://runtime.example','Content-Type':'application/json','X-Qinlin-Request':'1'},
      body:JSON.stringify({password:'runtime-test-password-long',turnstileToken:token})
    });
    assert.equal(response.status,expectedStatus,await response.clone().text());
    assert.ok(!response.headers.has('Set-Cookie'));
    return response;
  }
  await rejectedUnlock(undefined,403);
  await rejectedUnlock('runtime-token',403); // Real handler rejects the replayed mock Siteverify token.
  for (let i=0;i<3;i++) await rejectedUnlock('invalid-token',403);
  const blocked=await rejectedUnlock('invalid-token',429);
  assert.equal(blocked.headers.get('Retry-After'),'60');
  const callsBefore=outgoing.length;
  await rejectedUnlock('runtime-token',429);
  assert.equal(outgoing.length,callsBefore,'cooldown must skip Siteverify and upstream');
  console.log('PASS: 原生 Workers/DO 的加密会话、模拟登录开门、验证码重放拒绝及持久冷却；未连接真实短信或门禁。');
} finally { await mf.dispose(); }
