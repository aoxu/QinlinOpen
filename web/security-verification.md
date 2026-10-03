# 访问验证加固验收模板

本文为通用验收清单，不包含个人实例信息，也不代表任一部署已通过验收。实际结果请保存在本地私有记录中，勿提交部署地址、版本 UUID、账号标识或凭据。

## 本地验证

在 web 目录执行并记录实际结果：

```sh
npm test
npm run test:runtime
npm run deploy:dry
```

测试使用虚构账号和模拟上游。本地通过不代表生产验证码、短信或实体门已验证。

## 自有部署验证

- 替换 wrangler.jsonc 中的通用主机名与 Turnstile sitekey；通过 Worker Secrets 设置敏感配置。
- 确认部署包含 UNLOCK_LIMIT、VERIFY_LIMIT、UNLOCK_GUARD 绑定及相应 migration。
- 用自己的 HTTPS 根地址执行以下命令，示例地址需替换：

```sh
node --use-env-proxy scripts/security-smoke.mjs https://your-app.example.com
```

- 检查匿名状态、缺少验证码令牌时拒绝解锁、限流响应和未发放 Cookie。脚本不发送短信或请求开门。
- 在正常浏览器中验证真人验证码、正确密码解锁及令牌重放拒绝，单独记录结果。
- 在本人获授权的设备和门旁分别验收短信登录、快捷指令和实体门动作；服务端成功响应不能证明实体门已打开。

## 保护边界

应用层拒绝的请求仍进入 Worker。源码中的验证码、限流和冷却机制不构成免费额度保障；共享 IP 会共用冷却状态。

来源：[worker.js](src/worker.js)、[unlock-guard.js](src/unlock-guard.js)、[验证脚本](scripts/security-smoke.mjs)；平台行为参考 [Cloudflare 限流文档](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)。
