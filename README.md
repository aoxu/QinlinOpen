# QinlinOpen

一个非官方、开源的亲邻开门客户端，提供 Android App 和 Cloudflare 网页版。通过经过认证的网络接口直接请求开门，不使用无障碍服务、坐标点击、界面自动化或悬浮窗。

## 网页版 🌐

网页版由静态网页、Cloudflare Workers 同域代理和 Durable Objects 组成，无需安装 Android App，可在手机或电脑浏览器使用。部署配置中的 HTTPS 地址为 [亲邻开门网页版](https://your-app.example.com/)，访问需要部署者提供的访问密码，短信登录仅接受配置的家庭手机号白名单。

### 功能与使用

1. 打开网页，输入访问密码并完成安全验证。
2. 使用本人获授权的手机号发送短信验证码并登录，加载账号已有的门禁钥匙。
3. 点击门旁的开门按钮，或勾选多扇门后点击「开门已选」，查看逐门结果。
4. 如需自动请求开门，在「设置」中开启「进入页面自动开门已选」。该功能默认关闭；已有有效登录时，加载或刷新网页会触发一次，切回已有标签页或刷新钥匙列表不会触发，重新解锁或短信登录后需手动开门。

所选门和自动开门设置按账号保存在服务器，同账号不同浏览器共享；登录状态由各浏览器分别保存。首页提供「登录记录」及脱敏诊断日志，登录记录仅保存在当前浏览器，不跨设备同步；记录的是发现状态变化的时间，不能确定亲邻登录实际失效的时刻。

当前仓库的 `web/wrangler.jsonc` 配置为 `OPEN_ENABLED=true`，会请求真实开门；部署者可改为 `false` 后重新部署以禁用。接口成功只代表服务端接受请求，实体门是否打开需现场确认。

本地运行、Worker Secrets、家庭白名单、部署与验收步骤见 [`web/README.md`](web/README.md)。以上功能说明依据 [`web/public/index.html`](web/public/index.html)、[`web/src/worker.js`](web/src/worker.js) 与 [`web/wrangler.jsonc`](web/wrangler.jsonc)。

## iPhone / Apple Watch 快捷指令 ⌚

快捷指令每次运行发送一次「开门已选」请求，读取账号当前勾选的门；修改网页选择后无需重建指令，与网页自动开门开关无关。

### 生成绑定

1. 在 iPhone 浏览器的网页首页完成访问验证、短信登录，并勾选要开的门。
2. 在「设置」点击「绑定 iPhone / Apple Watch 快捷指令」，进入绑定页。
3. 点击「生成 / 重新绑定」，复制页面提供的请求地址和完整 `Authorization` 请求头值（包含 `Bearer` 和空格）。进入绑定页、生成或撤销绑定均不会开门。

### 在 iPhone 创建指令

1. 打开「快捷指令」App，新建指令并命名为「亲邻开门已选」。
2. 添加「URL」操作，粘贴绑定页提供的请求地址。
3. 添加「获取 URL 内容」，将方法设为 `POST`，按下表配置头部和请求体。

| 配置项 | 值 |
| --- | --- |
| 请求地址 | 绑定页提供的 HTTPS 地址，路径为 `/api/shortcut/open-selected` |
| 头部 `Authorization` | 绑定页复制的完整 `Bearer <绑定凭证>` |
| 头部 `Content-Type` | `application/json` |
| 请求体类型 | JSON |
| JSON 字段 | `action`，类型「文本」，值为 `open-selected` |

4. 添加「获取字典值」，键填 `message`，输入选择「获取 URL 内容」的结果。
5. 添加「显示内容」，显示上述字典值。在门旁运行一次，若出现联网授权提示，允许连接当前网站，并现场确认每扇门的动作。

批量请求可能部分成功；不要添加自动重试或循环。遇到超时先观察实体门状态，再决定是否手动运行。

### 同步到 Apple Watch

在 iPhone 的指令详情中开启「在 Apple Watch 上显示」，等待同步后在手表「快捷指令」App 运行。也可在支持的表盘上添加快捷指令复杂功能。手表需要可用网络，菜单名称及操作兼容性可能随系统版本变化，需在手表和门旁实测；iPhone 成功不代表手表已验证成功。

Apple 操作参考：[提出第一个 API 请求](https://support.apple.com/zh-cn/guide/shortcuts/apd58d46713f/ios)、[在 Apple Watch 上使用快捷指令](https://support.apple.com/zh-cn/guide/watch/apd99050d435/watchos)。本项目配置步骤来源：[`web/public/shortcuts.html`](web/public/shortcuts.html)。

### 凭证管理与故障处理

- 每账号保留一个绑定，可供自己的 iPhone 和手表使用。凭证仅生成时显示，离开或刷新页面后无法找回；丢失时重新绑定。
- 重新绑定使旧凭证失效；「撤销绑定」阻止旧指令后续请求，但不能取消已开始的请求。退出网页不会撤销绑定。
- 有效期不超过 90 天，且不超过生成时的网页访问验证期限。同账号重新短信登录会更新仍有效绑定的亲邻会话；已到期或撤销的绑定需重新生成，并更新快捷指令请求头。
- 没有已选门时回首页勾选；登录失效时回首页重新登录，若绑定已失效则重新绑定；操作过于频繁时稍后手动运行。
- 绑定凭证可请求开启账号当前勾选的门，请勿分享含凭证的快捷指令、截图或日志。移除白名单账号、轮换会话密钥、绑定到期或执行时遇到亲邻 401 均会使绑定不可用。

绑定实现与限制来源：[`web/src/worker.js`](web/src/worker.js) 和 [`web/README.md`](web/README.md)。

## Android App

### 功能

- 使用亲邻账号的短信验证码登录
- 拉取账号已有的全部门禁钥匙
- App 首页每把钥匙均可直接点击开门
- 长按卡片拖动手柄排序，并在本机加密保存顺序
- 添加小组件时明确选择钥匙，不自动匹配门名
- 提供 1×1 至 4×2 的响应式 Android 桌面小组件
- 小组件按尺寸切换内容，使用原生加载圈和 Material 实心成功图标
- 使用 Android Keystore 加密保存登录令牌
- 不包含广告、统计 SDK 或第三方跟踪代码

### 使用

1. 安装并打开 QinlinOpen。
2. 输入手机号，请求并填写短信验证码。
3. 在首页点击需要开启的钥匙卡片。
4. 从桌面的小组件列表添加 QinlinOpen，并在浮动配置窗中选择该组件使用的钥匙。

每个小组件分别加密保存自己绑定的钥匙，可以同时放置多个不同门禁的小组件。没有绑定钥匙时，小组件只会打开配置页，不会发起开门请求。

### 构建

需要 JDK 17 和 Android SDK 36：

```bash
./gradlew testDebugUnitTest assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

如果安装了 Google Android CLI，也可以运行：

```bash
android run --device=<serial> \
  --apks=app/build/outputs/apk/debug/app-debug.apk \
  --activity=top.rpone.qinlinopen.MainActivity
```

### 工作方式

客户端兼容亲邻开门 5.2.6（versionCode 3146）使用的认证和开门协议：

- 登录与钥匙列表通过 HTTPS 请求完成。
- 开门请求发送到 `open/doorcontrol/v2/open`。
- 服务端仍会校验用户会话以及账号是否拥有目标钥匙。
- 用户令牌只存放在本机，通过 Android Keystore 的 AES-GCM 密钥加密；应用禁止系统备份。

## 安全与限制

- 仅用于你本人获授权使用的账号和门禁。
- 本项目不会绕过登录、会话校验或钥匙授权。
- 亲邻不是本项目的赞助方或维护者；服务端协议升级后可能需要同步适配。
- App 内包含兼容官方客户端所需的协议常量。这些不是用户凭据，但可能随官方版本变化。
- 请勿在 Issue、截图或日志中提交手机号、验证码、sessionId 或完整服务端响应。

## 许可证

本项目自身代码使用 [MIT License](LICENSE)。亲邻商标、服务端、协议及官方客户端不在此许可证授权范围内。
