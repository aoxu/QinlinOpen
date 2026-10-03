# Cloudflare Web 最小验证

独立于 Android 工程的个人验证版：静态网页 + Workers 同域代理，Durable Objects 保存账号钥匙偏好。
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
npx wrangler secret put TURNSTILE_SECRET
```

值取自你本机 `.dev.vars`。SESSION_KEY 为 64 个十六进制字符。
Secrets 未齐或限流绑定缺失时，API 返回 503，不请求亲邻。
Turnstile 为托管模式，操作名为 `unlock`。`TURNSTILE_SITEKEY` 与生产 `TURNSTILE_HOSTNAMES` 配置于 wrangler.jsonc；生产后端不接受 localhost/127.0.0.1。开发时可在忽略的 `.dev.vars` 中覆盖测试 sitekey、secret 和本地主机名，禁止将测试密钥部署到生产。
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

### 已选开门与自动开门

- 每个门名左侧可勾选，逐项保存到账号专属 Durable Object；同账号不同浏览器共享选择与设置，登录 Cookie 仍各自独立。
- 顶部「开门已选」重新验证当前账号钥匙后并发发送，一批只消耗一次开门限流额度，逐门显示接受或失败。失效钥匙不发送，不自动重试。
- 「进入页面自动开门已选」默认关闭；开启后，在已有有效登录的页面初次加载或刷新时发送一次。修改设置、刷新钥匙列表、切回已有标签页不触发；重新解锁或短信登录后请手动点击按钮。
- 桌面快捷方式必须真正加载网页才会自动触发；浏览器复用已有标签页时需刷新。网页成功响应不能证明实体门已打开。
- 首次部署需要应用 `v1-door-preferences` 的 SQLite Durable Object migration 和 `DOOR_PREFERENCES` 绑定，无需手动创建数据库。未部署前线上不会生效。
- 钥匙偏好记录仅包含 stableId 和自动开门开关，不保存手机号字段、密码或上游会话令牌；账号名称用于定位独立对象。快捷指令绑定使用同一对象中的独立加密记录，详见下节。

存储实现参考：[Cloudflare SQLite Durable Object Storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)。

### iPhone / Apple Watch 快捷指令

首页「设置」中的「绑定 iPhone / Apple Watch 快捷指令」进入 `/shortcuts.html`。先在首页完成访问验证、短信登录和勾选，然后生成绑定；页面提供地址与 Authorization 请求头复制、完整的快捷指令配置及手表同步步骤。进入绑定页、生成绑定和撤销均不触发开门。

快捷指令通过 `POST /api/shortcut/open-selected` 调用，头部为 `Authorization: Bearer <绑定凭证>` 和 `Content-Type: application/json`，JSON 请求体可填写 `{"action":"open-selected"}`。响应 `message` 可直接用于「获取字典值」和「显示内容」，`results` 包含逐门结果。失败也返回 `message`。不支持 GET 或查询参数，不重试；此凭证不能用于其他接口。

每次调用读取当前账号的 `selectedIds`，复用网页「开门已选」的钥匙重新验证、批量部分失败处理、开门总开关及账号限流，不依赖 `autoOpen`。修改首页选择后快捷指令立即使用新选择。

每账号一个绑定：凭证为带用途、账号、随机绑定 ID 和到期时间的加密认证值，页面仅生成时显示；Durable Object 保存绑定 ID、到期时间和 AES-GCM 加密的亲邻会话，不保存明文上游令牌。有效期不超过访问验证期限及 90 天。重新绑定替换旧 ID，撤销清空记录；移除家庭白名单、轮换 SESSION_KEY、到期或快捷指令遇到上游 401 均使绑定不可用。退出网页仅删除浏览器 Cookie，不撤销绑定。撤销不能取消已经开始的开门请求。

绑定管理接口保持现有 Cookie、同源、自定义请求头验证；仅快捷指令执行端点使用 Bearer 认证，允许无 Origin 的原生请求，不开放浏览器跨域 CORS。执行响应不设置 Cookie，也不返回诊断详情。复用现有 DO，无需新增迁移或 Secret。绑定凭证能够请求账号当前所选门，请勿分享快捷指令或凭证截图。

测试只使用模拟短信与门禁。Apple Watch 动作兼容性、实际联网和实体门动作需在设备上验收；iPhone 请求成功不代表手表已验证。步骤参考：[Apple API 请求说明](https://support.apple.com/zh-cn/guide/shortcuts/apd58d46713f/ios)、[Apple Watch 快捷指令](https://support.apple.com/zh-cn/guide/watch/apd99050d435/watchos)。

### 诊断与复制日志

页面的「复制最近日志」可复制当前标签页最近 80 条诊断记录；刷新后保留，关闭标签页后不持久保留，可手动清空。
每次请求附带 requestId、版本、阶段和耗时；上游记录域名/路径（不含查询参数）、HTTP 状态、响应类型、业务错误码，以及脱敏后的异常名称、消息和底层 cause。
区分网络错误、8 秒超时、响应读取失败、空响应、非 JSON 响应和亲邻业务拒绝。不会把完整请求/响应、Cookie、手机号、验证码、密码、令牌或签名写入日志。
浏览器剪贴板不可用时尝试选区复制；仍失败会展开日志供手动复制。
诊断随 API 响应返回给已解锁的浏览器，仅存于该标签页 sessionStorage；未解锁请求不返回上游详情。未开启 Cloudflare 持久日志采集。

### 其他限制

首页「登录记录」保留本浏览器最近 50 次登录，包含服务端记录的登录成功时间、访问期限、最近上游验证时间、首次发现状态变化时间、登录至发现的间隔、接口、HTTP 状态、业务码与请求 ID。使用 localStorage，关闭页面后保留，清除网站数据会删除；不跨设备同步，不保存手机号、密码、验证码或令牌。

记录从更新后的成功短信登录开始，旧会话无法补出原始登录时间。发现时间不等于实际失效时间：只在使用网页接口时观察，没有后台轮询。区分亲邻 HTTP/业务码 401、网页访问到期、账号移出白名单、Cookie 不可用与主动退出；Cookie 丢失的具体成因及亲邻凭据被拒绝的内部原因无法确定。超时、限流、非 401 错误不标记为登录失效。快捷指令独立执行产生的失效不直接写入网页记录，网页再次请求上游时才能观察。

- 手机界面采用门名与按钮同行布局，日志与退出收进折叠区；390×640 浏览器视口下三把模拟钥匙均可见。
- 访问密码可以在不同浏览器使用，但支持逗号分隔的家庭手机号白名单。访问验证或成功短信登录后，网页访问期限为 90 天，普通访问不延长；亲邻登录不设本地到期时间，亲邻返回 401 时仅清除亲邻登录，保留访问验证。90 天后输入访问密码可恢复仍有效的亲邻登录。

- 代理地址固定，客户端不能指定任意上游 URL。开门前重新拉取账号钥匙并匹配 stableId；亲邻仍负责最终授权。
- 请求头延续 Android 协议，但使用随机 16 位设备 ID 和 qvendor=web。兼容性未获官方保证，必须实测。
- 保持 Java form URL 编码（空格为 +、冒号保留）、大写 MD5、AES-128-ECB/PKCS 填充和 multipart 格式。
- 会话用 AES-256-GCM 加密存放于 Secure/HttpOnly/SameSite=Strict Cookie，访问验证 90 天过期；浏览器 Cookie 存储设为 400 天并在成功访问时续存（不延长访问验证），浏览器清理数据仍会丢失登录；JS 不读取上游令牌。localStorage 仅保存无凭据的登录记录。
- 网页登录使用 Cookie；快捷指令绑定另在账号 DO 中保存加密会话。退出仅删除当前浏览器 Cookie，不注销亲邻服务端会话，也不能立即撤销已被复制的 Cookie；快捷指令请单独撤销。轮换 SESSION_KEY 可使全部 Cookie 和快捷指令凭证失效。
- 写操作校验同源 Origin、JSON 和自定义请求头。只接受配置的家庭白名单手机号，移除号码后旧会话不能继续使用。
- Cloudflare 限流：登录后每账号 30 次 API/分钟，未登录每 IP 30 次 API/分钟，每手机号 1 次短信/分钟、1 次开门/10秒。限流按 Cloudflare 数据中心执行，是尽力保护，不是全球严格锁或幂等保证。
- 密码接口另设每 IP 5 次请求/分钟；通过请求格式检查的验证请求还共用每数据中心 30 次/分钟的验证码验证额度。超限先返回 429，不访问持久验证对象或 Siteverify。
- 每次解锁要求一次性 Turnstile 令牌，服务端校验 success、hostname 和 action=unlock；验证不可用时拒绝解锁。已解锁会话的短信登录和开门不重复要求验证码。
- UnlockGuard 使用 HMAC(IP) 定位独立 Durable Object，串行检查验证码和密码并保存失败计数。前 4 次失败不锁定，第 5 次失败冷却 60 秒，后续失败依次冷却 5 分钟、15 分钟、1 小时（上限）；锁定时正确密码也不能绕过。成功清除计数，最后一次失败 24 小时后自动清理。密码、验证码令牌、原始 IP 不持久化。共享出口 IP 的家庭成员可能同时受到冷却限制。
- 保留 workers.dev：上述保护发生在 Worker 内部，拒绝的请求仍计入 Workers 请求额度，也会有受限的 Durable Object 调用。它降低密码猜测和后续调用，无法防止恶意请求耗尽免费请求额度；要保护额度需另行采用进入 Worker 前的边缘访问控制。
- 前端操作中禁用按钮；不自动重试短信或开门。不同浏览器/数据中心仍可能同时操作。
- 上游单请求超时 8 秒；小区最多 20 个；上游响应最多 1 MiB，请求体最多 4 KiB。
- 未记录个人信息和完整网络请求，Workers observability 默认关闭，API 全部 no-store。上游 sessionId 位于协议要求的 URL，运维时不要开启完整出站 URL 日志。
- API 成功仅代表服务端接受请求，无法证明门的物理状态。

协议来源：`../app/src/main/java/top/rpone/qinlinopen/data/QinlinApi.kt`。
平台文档：[Static Assets](https://developers.cloudflare.com/workers/static-assets/)、[Node crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)、[限流绑定](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)。
