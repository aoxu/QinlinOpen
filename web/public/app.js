const $ = id => document.getElementById(id);
let state = {unlocked: false, loggedIn: false, openEnabled: false}, busy = false, smsUntil = 0;
function message(text) { $('message').textContent = text; }
function render() {
  $('unlock').hidden = state.unlocked;
  $('login').hidden = !state.unlocked || state.loggedIn;
  $('keys').hidden = !state.loggedIn;
  $('logout').hidden = !state.unlocked;
  $('open-note').textContent = state.openEnabled ? '请在门旁操作，发送后现场确认。' : '当前仅验证钥匙列表，真实开门尚未启用。';
  document.querySelectorAll('button').forEach(b => { b.disabled = busy || (b.dataset.open === '1' && !state.openEnabled) || (b.id === 'sms' && Date.now() < smsUntil); });
}
async function api(path, body) {
  const response = await fetch(`/api/${path}`, body === undefined ? {cache:'no-store'} : {
    method:'POST', headers:{'Content-Type':'application/json','X-Qinlin-Request':'1'}, body:JSON.stringify(body), cache:'no-store'
  });
  const data = await response.json();
  if (response.status === 401) { state.unlocked = false; state.loggedIn = false; $('doors').replaceChildren(); render(); }
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}
async function run(task) {
  if (busy) return;
  busy = true; render(); message('正在处理…');
  try { await task(); } catch(e) { message(e.message || '网络异常；若正在开门，结果未知，请现场确认'); }
  finally { busy = false; render(); }
}
async function doors() {
  const data = await api('doors'); $('doors').replaceChildren();
  for (const key of data.doors) {
    const card = document.createElement('div'); card.className = 'door';
    const title = document.createElement('strong'); title.textContent = key.doorName;
    const community = document.createElement('p'); community.textContent = key.communityName;
    const button = document.createElement('button'); button.textContent = '开门'; button.dataset.open = '1';
    button.addEventListener('click', () => {
      if (busy || !state.openEnabled || !confirm(`确认请求开启「${key.communityName} ${key.doorName}」？`)) return;
      void run(async () => { const result = await api('open', {stableId:key.stableId,confirm:true}); message(result.message); });
    });
    card.append(title,community,button); $('doors').append(card);
  }
  message(data.doors.length ? `已加载 ${data.doors.length} 把钥匙。` : '账号没有可用钥匙。');
}
$('unlock-form').addEventListener('submit', e => { e.preventDefault(); void run(async () => {
  await api('unlock',{password:$('password').value}); $('password').value = '';
  state = await api('status'); message('已进入测试，请登录亲邻账号。');
}); });
$('sms').addEventListener('click', () => { if (!$('phone').reportValidity()) return; void run(async () => {
  await api('sms',{phone:$('phone').value}); smsUntil = Date.now()+60000; message('验证码已发送，请查收。');
}); });
$('login-form').addEventListener('submit', e => { e.preventDefault(); void run(async () => {
  await api('login',{phone:$('phone').value,code:$('code').value}); $('code').value = ''; state = await api('status'); await doors();
}); });
$('refresh').addEventListener('click', () => { void run(doors); });
$('logout').addEventListener('click', () => { void run(async () => {
  await api('logout',{}); state = {unlocked:false,loggedIn:false,openEnabled:false}; $('doors').replaceChildren(); $('phone').value = ''; $('code').value = ''; message('已清除本浏览器会话。');
}); });
setInterval(() => { const left = Math.max(0,Math.ceil((smsUntil-Date.now())/1000)); $('sms').textContent = left ? `${left} 秒后重发` : '发送验证码'; render(); },1000);
void run(async () => { state = await api('status'); if(state.loggedIn) await doors(); else message(state.unlocked ? '请输入手机号与验证码。' : '请输入测试访问密码。'); });
