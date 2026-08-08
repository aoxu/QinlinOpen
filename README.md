# QinlinOpen

一个非官方、开源的 Android 亲邻开门客户端。它通过经过认证的网络接口直接请求开门，不使用无障碍服务、坐标点击、界面自动化或悬浮窗。

## 功能

- 使用亲邻账号的短信验证码登录
- 拉取账号已有的全部门禁钥匙
- App 首页每把钥匙均可直接点击开门
- 长按卡片拖动手柄排序，并在本机加密保存顺序
- 添加小组件时明确选择钥匙，不自动匹配门名
- 提供 1×1 至 4×2 的响应式 Android 桌面小组件
- 小组件按尺寸切换内容，使用原生加载圈和 Material 实心成功图标
- 使用 Android Keystore 加密保存登录令牌
- 不包含广告、统计 SDK 或第三方跟踪代码

## 使用

1. 安装并打开 QinlinOpen。
2. 输入手机号，请求并填写短信验证码。
3. 在首页点击需要开启的钥匙卡片。
4. 从桌面的小组件列表添加 QinlinOpen，并在浮动配置窗中选择该组件使用的钥匙。

每个小组件分别加密保存自己绑定的钥匙，可以同时放置多个不同门禁的小组件。没有绑定钥匙时，小组件只会打开配置页，不会发起开门请求。

## 构建

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

## 工作方式

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
