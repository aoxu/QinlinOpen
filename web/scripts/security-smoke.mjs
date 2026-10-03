import assert from 'node:assert/strict';

// Only fake credentials; never obtain a cookie, send SMS or call a door endpoint.
const target = process.argv[2];
if (!target) throw new Error('请显式提供部署地址：node scripts/security-smoke.mjs https://your-app.example.com');
let url;
try { url = new URL(target); } catch { throw new Error('部署地址必须是有效的 HTTPS 地址。'); }
if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
  throw new Error('部署地址必须是 HTTPS 根地址，不含凭据、路径、查询参数或片段。');
}
const origin = url.origin;
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
