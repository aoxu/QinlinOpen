import assert from 'node:assert/strict';

// Only fake credentials; never obtain a cookie, send SMS or call a door endpoint.
const origin = 'https://your-app.example.com';
const headers = {Origin:origin,'Content-Type':'application/json','X-Qinlin-Request':'1'};
const status = await fetch(origin+'/api/status',{signal:AbortSignal.timeout(15000)});
assert.equal(status.status,200);
const info = await status.json();
assert.equal(info.unlocked,false); assert.ok(info.turnstileSitekey);
let limited = false;
const results = [];
for (let attempt=0; attempt<8; attempt++) {
  const response = await fetch(origin+'/api/unlock',{
    method:'POST',headers,body:JSON.stringify({password:'security-smoke-wrong-password'}),signal:AbortSignal.timeout(15000)
  });
  assert.ok(!response.headers.has('Set-Cookie'));
  const data = await response.json();
  results.push({status:response.status,retryAfter:response.headers.get('Retry-After')});
  if (response.status === 429) {
    assert.equal(data.retryAfter,60); limited=true;break;
  }
  assert.equal(response.status,403); assert.match(data.error,/安全验证/);
}
assert.equal(limited,true,'expected unlock limiter rejection within 8 requests');
console.log(JSON.stringify({anonymousStatus:status.status,unlocked:info.unlocked,unlockAttempts:results,limited},null,2));
