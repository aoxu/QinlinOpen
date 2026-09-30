import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import assert from 'node:assert/strict';

// Build the real Worker into workerd; replace only upstream I/O and rate-limit bindings.
const result = await build({stdin:{contents:`
import { createWorker } from './src/worker.js';
const transport = async (url) => {
  let data = {};
  if(url.includes('app/v1/login')) data = {sessionId:'runtime-fake-session'};
  if(url.includes('communityInfo')) data = [{communityId:1,communityName:'测试小区'}];
  if(url.includes('queryUserDoor')) data = [{doorControlId:2,doorName:'测试门'}];
  return Response.json({success:true,data});
};
const worker = createWorker(transport);
export default {fetch(request) {
  const limit = {limit:async()=>({success:true})};
  return worker.fetch(request,{
    SESSION_KEY:'11'.repeat(32),ACCESS_PASSWORD:'runtime-test-password-long',ALLOWED_PHONE:'13800000000',
    HEX_AES_KEY:'00'.repeat(16),SIGNING_SALT:'fake',SMS_APP_ID:'fake',SMS_APP_SECRET:'fake',
    OPEN_ENABLED:'true',API_LIMIT:limit,SMS_LIMIT:limit,OPEN_LIMIT:limit
  });
}};
`,resolveDir:process.cwd(),sourcefile:'runtime-entry.js'},bundle:true,write:false,format:'esm',platform:'node',target:'es2022',external:['node:*']});
const mf = new Miniflare({workers:[{config:{name:'poc-test',compatibilityDate:'2026-09-30',compatibilityFlags:['nodejs_compat'],manifest:{mainModule:'worker.js',modules:{'worker.js':{type:'esm',contents:result.outputFiles[0].text}}}}}]});
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
  await call('unlock',{password:'runtime-test-password-long'});
  await call('sms',{phone:'13800000000'});
  await call('login',{phone:'13800000000',code:'123456'});
  assert.equal((await call('status')).loggedIn,true);
  assert.equal((await call('doors')).doors[0].stableId,'1:2');
  assert.match((await call('open',{stableId:'1:2',confirm:true})).message,/现场确认/);
  await call('logout',{});
  assert.equal((await call('status')).loggedIn,false);
  console.log('PASS: workerd 加密、Cookie、模拟短信/登录/钥匙/开门/退出完整流程；未连接亲邻。');
} finally { await mf.dispose(); }
