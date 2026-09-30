# Cloudflare Web 最小验证

独立于 Android 工程的个人验证版：静态网页 + Workers 同域代理，无数据库。
支持短信登录、钥匙列表、点击直接请求开门，无确认弹窗。当前配置 `OPEN_ENABLED=true`；如需禁用，改为 `false` 后重新部署。
本目录的测试全部使用虚构账号和模拟上游，不发送短信、不调用真实门禁。

## 本地准备

需要 Node.js 22 或更新版本。在本目录执行：

```sh
npm ci
node scripts/setup-local.mjs
```

在本机编辑 `.dev.vars`，设置随机访问密码（至少 16 位）和逗号分隔的 `ALLOWED_PHONES`。实际号码只上传为 Cloudflare Secret，禁止提交 Git。
脚本从现有 Android 源码提取协议常量，并随机生成 32 字节会话密钥，绝不输出这些值。
`.dev.vars` 已加入忽略规则，切勿上传、截图或分享。

```sh
npm test
npm run test:runtime
npm run deploy:dry
npm run dev
```

打开终端显示的本地地址。Cookie 强制 Secure；浏览器对 localhost 的处理应现场验证。
手机访问应使用下述 Cloudflare HTTPS 测试部署，不能用普通局域网 HTTP 替代。

## Cloudflare 部署（单独执行）

```sh
npx wrangler login
npm run deploy
```

配置以下 Worker Secrets，每条通过交互提示输入，不要把值放入命令行：

```sh
npx wrangler secret put SESSION_KEY
npx wrangler secret put ACCESS_PASSWORD
npx wrangler secret put ALLOWED_PHONES
npx wrangler secret put SIGNING_SALT
npx wrangler secret put HEX_AES_KEY
npx wrangler secret put SMS_APP_ID
npx wrangler secret put SMS_APP_SECRET
```

值取自你本机 `.dev.vars`。SESSION_KEY 为 64 个十六进制字符。
Secrets 未齐或限流绑定缺失时，API 返回 503，不请求亲邻。
使用部署返回的 HTTPS 地址验证；无需先买域名。

## 验收顺序

1. 访问密码解锁；未解锁不能发送短信或获取钥匙。
2. 输入 allowlist 中本人获授权手机号，手动发送验证码。
3. 输入验证码登录，确认门名、小区和数量与现有客户端一致。
4. 记录是否出现超时、上游拒绝或设备参数兼容问题；不得分享完整响应或令牌。
5. 确认 `wrangler.jsonc` 的 `OPEN_ENABLED` 与预期一致；当前已启用真实开门。
6. 点击指定门即发送一次开门请求，现场检查实际动作。
7. 验证结束点击退出；必要时禁用开门或删除测试部署。

## 设计与限制

### 诊断与复制日志

页面的「复制最近日志」可复制当前标签页最近 80 条诊断记录；刷新后保留，关闭标签页后不持久保留，可手动清空。
每次请求附带 requestId、版本、阶段和耗时；上游记录域名/路径（不含查询参数）、HTTP 状态、响应类型、业务错误码，以及脱敏后的异常名称、消息和底层 cause。
区分网络错误、8 秒超时、响应读取失败、空响应、非 JSON 响应和亲邻业务拒绝。不会把完整请求/响应、Cookie、手机号、验证码、密码、令牌或签名写入日志。
浏览器剪贴板不可用时尝试选区复制；仍失败会展开日志供手动复制。
诊断随 API 响应返回给已解锁的浏览器，仅存于该标签页 sessionStorage；未解锁请求不返回上游详情。未开启 Cloudflare 持久日志采集。

### 其他限制

- 手机界面采用门名与按钮同行布局，日志与退出收进折叠区；390×640 浏览器视口下三把模拟钥匙均可见。
- 访问密码可以在不同浏览器使用，但支持逗号分隔的家庭手机号白名单。访问密码通过后固定 90 天有效，普通访问及短信登录不延长；亲邻登录不设本地到期时间，亲邻返回 401 时仅清除亲邻登录，保留访问验证。90 天后输入访问密码可恢复仍有效的亲邻登录。

- 代理地址固定，客户端不能指定任意上游 URL。开门前重新拉取账号钥匙并匹配 stableId；亲邻仍负责最终授权。
- 请求头延续 Android 协议，但使用随机 16 位设备 ID 和 qvendor=web。兼容性未获官方保证，必须实测。
- 保持 Java form URL 编码（空格为 +、冒号保留）、大写 MD5、AES-128-ECB/PKCS 填充和 multipart 格式。
- 会话用 AES-256-GCM 加密存放于 Secure/HttpOnly/SameSite=Strict Cookie，访问验证 90 天过期；浏览器 Cookie 存储设为 400 天并在成功访问时续存（不延长访问验证），浏览器清理数据仍会丢失登录；JS 不读取上游令牌，不使用 localStorage。
- 没有会话数据库，退出仅删除当前浏览器 Cookie，不注销亲邻服务端会话，也不能立即撤销已被复制的 Cookie。轮换 SESSION_KEY 可使全部测试 Cookie 失效。
- 写操作校验同源 Origin、JSON 和自定义请求头。只接受配置的家庭白名单手机号，移除号码后旧会话不能继续使用。
- Cloudflare 限流：登录后每账号 30 次 API/分钟，未登录每 IP 30 次 API/分钟，每手机号 1 次短信/分钟、1 次开门/10秒。限流按 Cloudflare 数据中心执行，是尽力保护，不是全球严格锁或幂等保证。
- 前端操作中禁用按钮；不自动重试短信或开门。不同浏览器/数据中心仍可能同时操作。
- 上游单请求超时 8 秒；小区最多 20 个；上游响应最多 1 MiB，请求体最多 4 KiB。
- 未记录个人信息和完整网络请求，Workers observability 默认关闭，API 全部 no-store。上游 sessionId 位于协议要求的 URL，运维时不要开启完整出站 URL 日志。
- API 成功仅代表服务端接受请求，无法证明门的物理状态。

协议来源：`../app/src/main/java/top/rpone/qinlinopen/data/QinlinApi.kt`。
平台文档：[Static Assets](https://developers.cloudflare.com/workers/static-assets/)、[Node crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)、[限流绑定](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)。
