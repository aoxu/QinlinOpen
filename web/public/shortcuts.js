import { copyText } from './clipboard.js';
const $ = id => document.getElementById(id);
async function api(path, body) {
  const response = await fetch('/api/'+path,{method:body === undefined?'GET':'POST',headers:body === undefined?{}:{'Content-Type':'application/json','X-Qinlin-Request':'1'},body:body === undefined?undefined:JSON.stringify(body)});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败，请稍后再试');
  return data;
}
function hideCredentials() { $('credentials').hidden=true; $('authorization').value=''; }
async function refresh() {
  const status = await api('status');
  if (!status.unlocked) throw new Error('请先返回首页完成访问验证，再进入此页。');
  const binding = await api('shortcut/status');
  $('binding-status').textContent=binding.bound?`已绑定，有效期至 ${new Date(binding.expiresAt).toLocaleString('zh-CN')}。重新生成会替换旧凭证。`:'当前没有有效绑定。';
  $('revoke').disabled=!binding.bound;
  if (!status.loggedIn) throw new Error('请返回首页短信登录。已有绑定可在此撤销。');
  const {doors,preferences} = await api('doors');
  $('selected-doors').replaceChildren();
  for (const id of preferences.selectedIds) {
    const li=document.createElement('li');
    li.textContent=doors.find(d=>d.stableId===id)?.doorName ?? '失效钥匙（请在首页取消勾选）';
    $('selected-doors').append(li);
  }
  $('bind').disabled=!preferences.selectedIds.length;
  $('message').textContent=preferences.selectedIds.length?'可生成绑定。此页不会触发开门。':'请先在首页勾选要开的门。';
}
let busy=false;
async function mutate(operation) {
  if (busy) return;
  busy=true; $('bind').disabled=$('revoke').disabled=true; hideCredentials();
  try {
    const data=await api('shortcut/'+operation,{});
    if (operation==='bind') {
      $('endpoint').value=location.origin+'/api/shortcut/open-selected';
      $('authorization').value='Bearer '+data.token;
      $('credentials').hidden=false;
    }
    await refresh();
    $('message').textContent=operation==='bind'?'绑定已生成，请按下方步骤配置快捷指令。':'绑定已撤销。旧快捷指令不能再发起开门请求。';
  } catch(error) {
    try { await refresh(); } catch { /* Keep the original operation error visible. */ }
    $('message').textContent=error.message;
  }
  finally { busy=false; }
}
$('bind').addEventListener('click',()=>mutate('bind'));
$('revoke').addEventListener('click',()=>mutate('revoke'));
for (const name of ['endpoint','authorization']) $('copy-'+name).addEventListener('click',async()=>{
  $('message').textContent=await copyText($(name).value)?'已复制。':'复制失败，请在上面的文本框中手动选择并复制。';
});
window.addEventListener('pagehide',hideCredentials);
for (const button of document.querySelectorAll('[data-copy]')) button.addEventListener('click',async()=>{
  const value=button.dataset.copy;
  const copied=await copyText(value);
  $('step-copy-status').textContent=copied?`已复制「${value}」。`:`复制失败，请手动复制：${value}`;
});
refresh().catch(error=>{ $('message').textContent=error.message; });
