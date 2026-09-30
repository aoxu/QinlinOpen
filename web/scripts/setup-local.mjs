import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
// Extract only existing protocol constants. Never print them or overwrite existing credentials.
if (existsSync('.dev.vars')) throw new Error('.dev.vars 已存在，请手动维护，脚本不会覆盖。');
const source = readFileSync('../app/src/main/java/top/rpone/qinlinopen/data/QinlinApi.kt','utf8');
const names = ['SIGNING_SALT','HEX_AES_KEY','SMS_APP_ID','SMS_APP_SECRET'];
const lines = names.map(name=>{
  const value = source.match(new RegExp(`private const val ${name} = "([^"]+)"`))?.[1];
  if(!value) throw new Error(`找不到协议常量 ${name}`);
  return `${name}=${JSON.stringify(value)}`;
});
lines.push(`SESSION_KEY="${randomBytes(32).toString('hex')}"`,'ACCESS_PASSWORD="REPLACE_WITH_AT_LEAST_16_RANDOM_CHARACTERS"','ALLOWED_PHONE="REPLACE_WITH_YOUR_PHONE"');
writeFileSync('.dev.vars',lines.join('\n')+'\n',{mode:0o600,flag:'wx'});
console.log('已生成忽略提交的 .dev.vars。请在本机编辑 ACCESS_PASSWORD 和 ALLOWED_PHONE，勿分享文件内容。');
