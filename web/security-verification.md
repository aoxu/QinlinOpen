# 访问验证加固验收

时间：2026-09-30 23:40 GMT+8。

## 部署证据

- 地址：https://qinlinopen-web-poc.blindgamer.workers.dev/
- 最终部署版本：`0c134974-e94d-4600-81e9-243ed8bc8bf6`（Wrangler deploy 输出）。
- 构建标识：`web-unlock-guard-v6`。
- 控制台已确认 `TURNSTILE_SECRET` 作为生产加密密钥保存；不在代码或报告中保留其值。
- 部署包含 `UNLOCK_LIMIT`、`VERIFY_LIMIT` 和 `UNLOCK_GUARD` 绑定及 v2 SQLite DO migration。

## 已通过

- 32 项 Node 测试；前端 SDK/DOM 同名兼容问题修复后另通过针对性回归测试。
- 原生 workerd/Miniflare：加密会话、模拟登录/开门、Siteverify 模拟令牌重放拒绝、5 次失败持久冷却、冷却期间不请求 Siteverify。
- 部署预检与实际部署成功。
- 线上匿名 `/api/status` 返回 200，未解锁且带公开 sitekey。
- 缺少令牌返回 403；伪造令牌经线上 Siteverify 拒绝后返回 403。
- `node --use-env-proxy scripts/security-smoke.mjs`：连续 7 次无令牌请求，第 7 次返回 429、Retry-After:60，未发放 Cookie。配置为每分钟 5 次，Cloudflare 限流最终一致，短暂超额不代表严格次数承诺。
- 所有测试均未请求真实短信或真实开门。

## 尚未通过的真实浏览器验收

自动化内置浏览器无法加载 challenges.cloudflare.com 验证码脚本；Edge 自动化访问报告 `net::ERR_BLOCKED_BY_CLIENT`。尚未确认真实浏览器取得生产令牌后的成功密码解锁和真实令牌重放拒绝，已请求用户以正常浏览器/无痕窗口验收。不能将模拟 Siteverify 的测试当作生产真人验证成功。

## 保护边界

用户选择保留 workers.dev，仅应用层加固。所有 API 请求先进入 Worker，拒绝请求仍消耗 Workers 请求额度。验证码和限流保护密码猜测及后续调用，无法保证免费额度不被分布式流量耗尽；冷却状态按 HMAC(IP) 隔离，换 IP 可获得另一组计数，共享 IP 的用户也会共用冷却。

来源：本次源码、控制台、部署及测试输出；Cloudflare 限流官方文档：https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ 。
