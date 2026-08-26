---
title: 🖥️ WebUI 管理面板
---

# 🖥️ WebUI 管理面板

通过浏览器就能管理你的机器人！

## 第一次使用

### 获取登录密码

第一次启动 MaiBot 时，控制台会显示一个密码（Token）：

```
WebUI Access Token: a1b2c3d4...
请使用此 Token 登录 WebUI
```

首次显示的是本次启动使用的临时 Token。登录后，首次配置向导会要求你设置一个符合安全要求的固定 Token；临时 Token 会在下次启动时重新生成。

### 登录步骤

1. 打开浏览器，访问 `http://localhost:8001`（默认地址）
2. 输入控制台显示的密码
3. 首次登录时按向导设置固定 Token，并使用新 Token 重新登录
4. 完成首次配置后进入管理面板

## 能做什么？

WebUI 让你轻松管理 MaiBot：

- ⚙️ **改配置** - 不用编辑文件，点点鼠标就能改设置
- 🧠 **管记忆** - 查看、编辑、删除机器人的记忆
- 🔌 **装插件** - 安装和管理各种功能插件
- 📊 **看统计** - 查看聊天记录和使用数据

## 基本设置

在 `bot_config.toml` 里可以改 WebUI 的设置：

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
[webui]
enabled = true                # 是否启用 WebUI
host = ["127.0.0.1", "::1"]  # 绑定地址列表
port = 8001                   # 端口号
mode = "production"           # 运行模式：development(开发) 或 production(生产)
webui_style = 1               # 界面风格
anti_crawler_mode = "basic"   # 防爬虫模式：false / strict / loose / basic
allowed_ips = "127.0.0.1"     # IP 白名单（逗号分隔）
```

:::

- `host` 改成 `["0.0.0.0", "::"]` 可以监听所有 IPv4/IPv6 网卡；同时应配置防火墙、访问白名单和 HTTPS
- `port` 可以改成其他数字避免冲突

## 忘记密码怎么办？

如果仍能登录，可在 WebUI 的系统设置中重新生成或修改 Token。如果已经无法登录：

1. 关闭 MaiBot
2. 删除 `data/webui.json` 文件
3. 重新启动 MaiBot，使用控制台显示的新临时 Token 登录，并重新设置固定 Token

## 安全提醒

- 不要把密码告诉别人
- 公网部署必须优先使用 HTTPS 或可信私有网络；仅修改默认端口不能替代访问控制
- 怀疑 Token 泄露时应立即在系统设置中重新生成

## 更多功能

- [配置管理](./config-management.md) - 在浏览器里改配置
- [记忆管理](./memory-management.md) - 查看和管理记忆
- [插件管理](./plugin-management.md) - 安装和管理插件
- [聊天记录](./chat-stats.md) - 查看聊天统计
