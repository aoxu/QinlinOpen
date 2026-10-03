export const HISTORY_KEY = 'qinlin-login-history-v1';
export function observeLogin(records, info, operation, ok, requestId) {
  if (!info || !Number.isFinite(info.observedAt)) return records;
  let record = info.loginId ? records.find(r=>r.id === info.loginId) : records.find(r=>!r.endedAt);
  if (!record && info.loggedIn && info.loginId) {
    for (const previous of records.filter(r=>!r.endedAt)) {
      previous.endedAt = info.observedAt;
      previous.events.push({detectedAt:info.observedAt,reason:'replaced',message:'本浏览器已切换到新的登录；旧登录实际是否失效未知',operation,requestId,elapsedMs:Number.isFinite(previous.loggedInAt) ? Math.max(0,info.observedAt-previous.loggedInAt) : null});
    }
    record = {id:info.loginId,loggedInAt:info.loggedInAt,events:[]};
    records.unshift(record);
  }
  if (!record) return records;
  record.accessExpiresAt = info.accessExpiresAt;
  if (info.reason && (!info.loggedIn || info.reason === 'logout') && !record.endedAt) {
    record.endedAt = info.detectedAt ?? info.observedAt;
    record.events.push({detectedAt:record.endedAt,reason:info.reason,message:info.message,
      operation:info.operation ?? operation,requestId,upstreamStatus:info.upstreamStatus,businessCode:info.businessCode,
      elapsedMs:Number.isFinite(record.loggedInAt) ? Math.max(0,record.endedAt-record.loggedInAt) : null});
  } else if (info.loggedIn && !info.reason) {
    delete record.endedAt;
    // Status only checks our cookie. A successful upstream request verifies the real login.
    if (ok && ['doors','open','open-selected','shortcut/bind'].includes(operation)) record.lastVerifiedAt = info.observedAt;
  }
  record.events = record.events.slice(-10);
  return records.slice(0,50);
}
export function historyText(records) {
  const date = value=>Number.isFinite(value) ? new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}) : '未知（旧会话未记录）';
  const duration = ms=>ms == null ? '未知' : `${Math.floor(ms/86400000)} 天 ${Math.floor(ms/3600000)%24} 小时 ${Math.floor(ms/60000)%60} 分 ${Math.floor(ms/1000)%60} 秒`;
  if (!records.length) return '尚无记录，从更新后首次成功登录开始记录。';
  return records.map(r=>[
    `登录成功：${date(r.loggedInAt)}`,
    `网页访问到期：${date(r.accessExpiresAt)}`,
    `最近确认亲邻登录有效：${date(r.lastVerifiedAt)}`,
    `登录至最近验证：${duration(Number.isFinite(r.lastVerifiedAt) && Number.isFinite(r.loggedInAt) ? Math.max(0,r.lastVerifiedAt-r.loggedInAt) : null)}`,
    ...r.events.map(e=>`发现状态变化：${date(e.detectedAt)}\n登录至发现：${duration(e.elapsedMs)}\n原因：${e.message}\n接口：${e.operation}；HTTP：${e.upstreamStatus ?? '未知'}；业务码：${e.businessCode ?? '未知'}；请求：${e.requestId ?? '未知'}`),
    r.endedAt ? '当前：已结束或需要重新验证' : '当前：尚未发现失效（不代表实时验证）'
  ].join('\n')).join('\n\n────────\n\n');
}
