import { BUILD, createLogBuffer, redact } from './diagnostics.js';
import { copyText } from './clipboard.js';
import { HISTORY_KEY, observeLogin, historyText } from './login-history.js';
const $ = id => document.getElementById(id);
let loginHistory = [], historyStorageAvailable = true;
try {
  const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
  if (Array.isArray(saved)) loginHistory = saved.filter(r=>r && typeof r.id === 'string' && Array.isArray(r.events)).slice(0,50);
} catch { historyStorageAvailable = false; }
function showHistory() {
  $('login-history-output').textContent = historyText(loginHistory);
  $('login-history-storage').textContent = historyStorageAvailable ? '仅保存在本浏览器，最多 50 次；关闭页面后保留，清除网站数据会删除。时间为北京时间。发现时间不等于实际失效时间；网络错误不会被记为登录失效。' : '浏览器存储不可用，记录仅在当前页面保留。';
}
showHistory();
let state = {unlocked: false, loggedIn: false, openEnabled: false}, busy = false, smsUntil = 0;
let preferences = {selectedIds:[],autoOpen:false}, currentDoors = [], initialAutoAttempted = false;
let turnstileToken = '', turnstileWidget, turnstileLoading, unlockUntil = 0;
async function prepareTurnstile(sitekey) {
  if (!sitekey || state.unlocked || turnstileWidget !== undefined) return;
  try {
    if (typeof window.turnstile?.render !== 'function') {
      turnstileLoading ??= new Promise((resolve,reject)=>{
        const script = document.createElement('script');
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.async = true; script.onload = resolve;
        script.onerror = ()=>reject(new Error('安全验证加载失败，请检查网络后刷新页面。'));
        document.head.append(script);
      });
      await turnstileLoading;
    }
    turnstileWidget = window.turnstile.render('#turnstile-widget',{
      sitekey,action:'unlock',size:'flexible',
      callback:token=>{turnstileToken=token;$('verification-status').textContent='安全验证已通过。';render();},
      'expired-callback':()=>{turnstileToken='';$('verification-status').textContent='安全验证已过期，请重新验证。';render();},
      'error-callback':()=>{turnstileToken='';$('verification-status').textContent='安全验证失败，请刷新页面重试。';render();},
      'timeout-callback':()=>{turnstileToken='';$('verification-status').textContent='安全验证超时，请重新验证。';render();}
    });
  } catch(error) { $('verification-status').textContent=error.message; }
}
function resetTurnstile() {
  turnstileToken='';
  if (turnstileWidget !== undefined) window.turnstile.reset(turnstileWidget);
  $('verification-status').textContent='请完成安全验证。';
}
const logs = createLogBuffer(80), storageKey = 'qinlin-diagnostics-v1';
try {
  const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? '[]');
  if(Array.isArray(saved)) saved.slice(-80).forEach(entry => { if(entry && typeof entry === 'object') logs.append(entry); });
} catch { /* Diagnostics are still available when storage is disabled. */ }
function secrets() { return [...['phone','code','password'].map(id=>$(id).value),turnstileToken].filter(Boolean); }
function log(entry) {
  logs.append({time:new Date().toISOString(),source:'browser',build:BUILD,...entry},secrets());
  $('log-output').textContent = logs.export();
  try { sessionStorage.setItem(storageKey,JSON.stringify(logs.snapshot())); } catch { /* keep in memory */ }
}
log({event:'page.ready'});
function message(text) { $('message').textContent = text; }
function render() {
  $('unlock').hidden = state.unlocked;
  $('login').hidden = !state.unlocked || state.loggedIn;
  $('keys').hidden = !state.loggedIn;
  $('refresh').hidden = !state.loggedIn;
  $('logout').hidden = !state.unlocked;
  $('open-selected').hidden = !state.loggedIn;
  $('settings').hidden = !state.loggedIn;
  $('auto-open').checked = preferences.autoOpen;
  const selectedCount = currentDoors.filter(k=>preferences.selectedIds.includes(k.stableId)).length;
  $('open-selected').textContent = selectedCount ? `开门已选（${selectedCount}）` : '开门已选';
  document.querySelectorAll('button').forEach(b => { b.disabled = (busy && !['copy-logs','clear-logs'].includes(b.id)) || (b.dataset.open === '1' && !state.openEnabled) || (b.id === 'sms' && Date.now() < smsUntil); });
  $('open-selected').disabled ||= !selectedCount;
  $('unlock-submit').disabled ||= !turnstileToken || Date.now() < unlockUntil;
  const unlockLeft = Math.max(0,Math.ceil((unlockUntil-Date.now())/1000));
  $('unlock-submit').textContent = unlockLeft ? `${unlockLeft} 秒后重试` : '进入';
  document.querySelectorAll('input[type="checkbox"]').forEach(input=>{input.disabled = busy;});
}
async function api(path, body) {
  const started = performance.now(); let stage = 'fetch';
  log({event:'api.start',operation:path,stage});
  try {
  const response = await fetch(`/api/${path}`, body === undefined ? {cache:'no-store'} : {
    method:'POST', headers:{'Content-Type':'application/json','X-Qinlin-Request':'1'}, body:JSON.stringify(body), cache:'no-store'
  });
  stage = 'parse';
  log({event:'api.response',operation:path,status:response.status,contentType:response.headers.get('Content-Type'),requestId:response.headers.get('X-Request-ID'),elapsedMs:Math.round(performance.now()-started)});
  let data;
  try { data = await response.json(); }
  catch { throw new Error(`代理返回非 JSON 响应（HTTP ${response.status}）`); }
  loginHistory = observeLogin(loginHistory,data.loginInfo,path,response.ok,data.requestId);
  try { localStorage.setItem(HISTORY_KEY,JSON.stringify(loginHistory)); } catch { historyStorageAvailable = false; }
  showHistory();
  if(Array.isArray(data.diagnostics)) data.diagnostics.forEach(entry=>{ if(entry && typeof entry === 'object') log(entry); });
  if (path === 'unlock' && data.retryAfter) unlockUntil = Date.now() + data.retryAfter * 1000;
  stage = 'validate';
  if (response.status === 401) { state.unlocked = Boolean(data.unlocked); state.loggedIn = false; $('doors').replaceChildren(); void prepareTurnstile(data.turnstileSitekey); render(); }
  if (!response.ok) throw new Error(`${data.error || '请求失败'}${data.requestId ? `（请求 ${data.requestId}）` : ''}`);
  log({event:'api.success',operation:path,requestId:data.requestId,elapsedMs:Math.round(performance.now()-started)});
  return data;
  } catch(error) {
    log({event:'api.error',operation:path,stage,errorName:error.name,errorMessage:error.message,elapsedMs:Math.round(performance.now()-started)});
    throw new Error(redact(error.message,secrets()) || '网络请求失败，请查看诊断日志');
  }
}
async function run(task) {
  if (busy) return;
  busy = true; render(); message('正在处理…');
  try { await task(); } catch(e) { message(e.message || '请求失败，请查看诊断日志'); }
  finally { busy = false; render(); }
}
async function doors() {
  const data = await api('doors'); $('doors').replaceChildren();
  preferences = data.preferences; currentDoors = data.doors;
  for (const key of data.doors) {
    const card = document.createElement('div'); card.className = 'door';
    const info = document.createElement('div'); info.className = 'door-info';
    const title = document.createElement('strong'); title.textContent = key.doorName;
    const selection = document.createElement('input'); selection.type = 'checkbox'; selection.className = 'door-selection';
    selection.checked = preferences.selectedIds.includes(key.stableId);
    selection.setAttribute('aria-label',`选择 ${key.doorName}`);
    selection.addEventListener('change',()=>{
      const selected = selection.checked;
      if (busy) { selection.checked = preferences.selectedIds.includes(key.stableId); return; }
      void run(async()=>{
        try { preferences = (await api('preferences',{stableId:key.stableId,selected})).preferences; message('钥匙选择已保存。'); }
        finally { selection.checked = preferences.selectedIds.includes(key.stableId); }
      });
    });
    const community = document.createElement('p'); community.textContent = key.communityName;
    const button = document.createElement('button'); button.textContent = '开门'; button.dataset.open = '1';
    button.addEventListener('click', () => {
      if (busy || !state.openEnabled) return;
      void run(async () => { const result = await api('open', {stableId:key.stableId}); message(result.message); });
    });
    info.append(title,community); card.append(selection,info,button); $('doors').append(card);
  }
  message(data.doors.length ? (state.openEnabled ? '' : '开门暂未启用') : '账号没有可用钥匙。');
}
async function openSelected(automatic = false) {
  const data = await api('open-selected',{automatic});
  $('batch-results').replaceChildren();
  for (const result of data.results) {
    const item = document.createElement('li');
    item.textContent = `${result.doorName || '失效钥匙'}：${result.ok ? '✓ ' : '⚠ '}${result.message}`;
    $('batch-results').append(item);
  }
  const accepted = data.results.filter(r=>r.ok).length;
  message(`已发送：${accepted}/${data.results.length} 个门的请求被接受，请现场确认。${data.loggedIn ? '' : '登录已失效，请重新登录。'}`);
  if (!data.loggedIn) {state.loggedIn = false; $('doors').replaceChildren();}
}
$('open-selected').addEventListener('click',()=>{void run(()=>openSelected());});
$('auto-open').addEventListener('change',()=>{
  const autoOpen = $('auto-open').checked;
  if (busy) {render();return;}
  void run(async()=>{
    preferences = (await api('preferences',{autoOpen})).preferences;
    message(autoOpen ? '已开启：下次加载或刷新页面时自动开门已选。' : '进入页面自动开门已关闭。');
  });
});
$('unlock-form').addEventListener('submit', e => { e.preventDefault(); void run(async () => {
  if (!turnstileToken || Date.now() < unlockUntil) throw new Error('请完成安全验证并等待冷却结束。');
  try { await api('unlock',{password:$('password').value,turnstileToken}); }
  finally { resetTurnstile(); }
  $('password').value = '';
  state = await api('status'); if(state.loggedIn) await doors(); else message('访问验证通过，请登录亲邻账号。');
}); });
$('sms').addEventListener('click', () => { if (!$('phone').reportValidity()) return; void run(async () => {
  await api('sms',{phone:$('phone').value}); smsUntil = Date.now()+60000; message('验证码已发送，请查收。');
}); });
$('login-form').addEventListener('submit', e => { e.preventDefault(); void run(async () => {
  await api('login',{phone:$('phone').value,code:$('code').value}); $('code').value = ''; state = await api('status'); await doors();
}); });
$('refresh').addEventListener('click', () => { void run(doors); });
$('logout').addEventListener('click', () => { void run(async () => {
  await api('logout',{}); state = await api('status'); $('doors').replaceChildren(); $('phone').value = ''; $('code').value = ''; resetTurnstile(); void prepareTurnstile(state.turnstileSitekey); message('已清除本浏览器会话。');
}); });
$('copy-logs').addEventListener('click', async () => {
  const copied = await copyText(logs.export());
  $('copy-status').textContent = copied ? '日志已复制，可粘贴给我排查。' : '自动复制失败，请展开日志后手动选择并复制。';
  if(!copied) { $('log-details').open = true; $('log-output').focus(); }
});
$('clear-logs').addEventListener('click', () => {
  logs.clear(); try { sessionStorage.removeItem(storageKey); } catch { /* no storage */ }
  $('log-output').textContent = logs.export(); $('copy-status').textContent = '最近日志已清空。';
});
$('copy-login-history').addEventListener('click',async()=>{
  const copied = await copyText(historyText(loginHistory));
  $('login-history-copy-status').textContent = copied ? '登录记录已复制。' : '请手动选择下方记录复制。';
});
setInterval(() => { const left = Math.max(0,Math.ceil((smsUntil-Date.now())/1000)); $('sms').textContent = left ? `${left} 秒后重发` : '发送验证码'; render(); },1000);
void run(async () => {
  state = await api('status');
  void prepareTurnstile(state.turnstileSitekey);
  if(state.loggedIn) {
    await doors();
    if (!initialAutoAttempted && preferences.autoOpen && state.openEnabled && currentDoors.some(k=>preferences.selectedIds.includes(k.stableId))) {
      initialAutoAttempted = true;
      await openSelected(true);
    }
  } else message(state.unlocked ? '请输入手机号与验证码。' : '请输入访问密码。');
});
