import test from 'node:test';
import assert from 'node:assert/strict';
import { UnlockGuard, verifyTurnstile, unlockIdentity } from '../src/unlock-guard.js';
import { createWorker } from '../src/worker.js';
import { guardContext, guardBinding } from './guard-binding.js';

const env = {ACCESS_PASSWORD:'test-password-long-enough',TURNSTILE_SECRET:'fake-secret',TURNSTILE_HOSTNAMES:'poc.example'};
const request = (password='wrong', token='valid')=>new Request('https://internal/',{method:'POST',body:JSON.stringify({password,token,ip:'192.0.2.1'})});

test('persistent guard serializes concurrent failures; cooldown survives object recreation and escalates',async()=>{
  const original = Date.now; let now = 1000000; Date.now=()=>now;
  try {
    const values = new Map(); let verifications = 0;
    const verifier=async()=>{verifications++;return true;};
    let guard = new UnlockGuard(guardContext(values),env,verifier);
    const results=await Promise.all(Array.from({length:10},()=>guard.fetch(request())));
    assert.deepEqual(results.map(r=>r.status),[401,401,401,401,429,429,429,429,429,429]);
    assert.equal(verifications,5);
    guard=new UnlockGuard(guardContext(values),env,verifier);
    assert.equal((await guard.fetch(request(env.ACCESS_PASSWORD))).status,429);
    for (const seconds of [300,900,3600,3600]) {
      now = values.get('state').blockedUntil;
      const response=await guard.fetch(request());
      assert.equal((await response.json()).retryAfter,seconds);
    }
    now = values.get('state').blockedUntil;
    assert.equal((await guard.fetch(request(env.ACCESS_PASSWORD))).status,200);
    assert.equal(values.size,0);
  } finally { Date.now=original; }
});

test('invalid and replayed tokens never accept a correct password; upstream failures fail closed',async()=>{
  let used=false;
  const guard=new UnlockGuard(guardContext(),env,async token=>{if(token!=='valid'||used)return false;used=true;return true;});
  assert.equal((await guard.fetch(request(env.ACCESS_PASSWORD,'invalid'))).status,403);
  assert.equal((await guard.fetch(request(env.ACCESS_PASSWORD))).status,200);
  assert.equal((await guard.fetch(request(env.ACCESS_PASSWORD))).status,403);
  const unavailable=new UnlockGuard(guardContext(),env,async()=>{throw new Error('down');});
  assert.equal((await unavailable.fetch(request(env.ACCESS_PASSWORD))).status,503);
});

test('Siteverify checks hostname/action/success and bounds tokens without making a request',async()=>{
  let calls=0; let result={success:true,hostname:'poc.example',action:'unlock'};
  const transport=async(url,options)=>{
    calls++;assert.equal(url,'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    assert.equal(options.body.get('remoteip'),'192.0.2.1');
    assert.equal(options.body.get('secret'),'fake-secret');return Response.json(result);
  };
  assert.equal(await verifyTurnstile('', '192.0.2.1',env,transport),false);
  assert.equal(await verifyTurnstile('a'.repeat(2049),'192.0.2.1',env,transport),false);assert.equal(calls,0);
  assert.equal(await verifyTurnstile('valid','192.0.2.1',env,transport),true);
  for (const change of [{hostname:'localhost'},{action:'login'},{success:false},{success:'true'}]) {
    result={success:true,hostname:'poc.example',action:'unlock',...change};
    assert.equal(await verifyTurnstile('valid','192.0.2.1',env,transport),false);
  }
  assert.match(unlockIdentity('192.0.2.1','key'),/^[a-f0-9]{64}$/);
  assert.notEqual(unlockIdentity('192.0.2.1','key'),unlockIdentity('192.0.2.2','key'));
});

test('Worker rejects missing tokens / missing configuration / rate limits before persistent guard',async()=>{
  let calls=0;
  const limit={limit:async()=>({success:true})};
  const config={...env,SESSION_KEY:'11'.repeat(32),ALLOWED_PHONE:'13800000000',HEX_AES_KEY:'00'.repeat(16),
    SIGNING_SALT:'fake',SMS_APP_ID:'fake',SMS_APP_SECRET:'fake',API_LIMIT:limit,SMS_LIMIT:limit,OPEN_LIMIT:limit,
    UNLOCK_LIMIT:limit,VERIFY_LIMIT:limit,TURNSTILE_SITEKEY:'fake',UNLOCK_GUARD:guardBinding(env,async()=>{calls++;return true;})};
  const req=body=>new Request('https://poc.example/api/unlock',{method:'POST',headers:{Origin:'https://poc.example','Content-Type':'application/json','X-Qinlin-Request':'1','CF-Connecting-IP':'192.0.2.1'},body:JSON.stringify(body)});
  const worker=createWorker(()=>{throw new Error('upstream must not be called');});
  assert.equal((await worker.fetch(req({password:env.ACCESS_PASSWORD}),config)).status,403);
  assert.equal((await worker.fetch(req({password:env.ACCESS_PASSWORD,turnstileToken:'valid'}),{...config,TURNSTILE_SECRET:''})).status,503);
  const blocked={limit:async()=>({success:false})};
  for (const binding of ['UNLOCK_LIMIT','VERIFY_LIMIT']) {
    const response=await worker.fetch(req({password:env.ACCESS_PASSWORD,turnstileToken:'valid'}),{...config,[binding]:blocked});
    assert.equal(response.status,429); assert.equal(response.headers.get('Retry-After'),'60');
  }
  assert.equal(calls,0);
  assert.equal((await worker.fetch(req({password:env.ACCESS_PASSWORD,turnstileToken:'valid'}),config)).status,200);
  assert.equal(calls,1);
});
