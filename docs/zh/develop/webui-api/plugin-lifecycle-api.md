---
title: 插件生命周期 API
---

# 插件生命周期 API

本文档覆盖插件安装、更新、启用/禁用、配置编辑、运行时组件查询、图标获取、统计代理以及进度跟踪的完整 HTTP 接口。面向部署运维和脚本化使用者，所有端点挂在 `/api/webui/plugins/` 下，均需 Cookie 认证（参考 [认证模型](./index.md#认证模型三种方式)）。

如果你要调试插件的 Host/Runner 通信协议、熔断逻辑或进程生命周期，请转 [插件运行时内部架构](../plugin-runtime-internals.md)。本文只讲 API 操作，不涉及运行时协议细节。

## 1. 已安装插件查询

两个端点返回插件列表和元数据：

- **`GET /api/webui/plugins/installed`** — 返回所有已安装插件的 manifest、启用状态、运行时加载状态和熔断信息。响应中每个插件条目包含 `id`、`manifest`、`path`、`enabled`、`load_status`、`load_error`、`circuit_status`、`changelog` 等字段。
- **`GET /api/webui/plugins/local-readme/{plugin_id}`** — 获取插件本地 README 内容（Markdown 字符串）。
- **`GET /api/webui/plugins/local-changelog/{plugin_id}`** — 获取插件本地 CHANGELOG 内容。

**查询示例：**

::: code-group

```bash [curl 查询已安装插件 ~vscode-icons:file-type-http~]
curl -X GET http://127.0.0.1:8001/api/webui/plugins/installed \
  -H "Cookie: maibot_session=你的Token"
```

:::

## 2. 安装 / 卸载 / 更新

三个 POST 端点实现插件生命周期管理。它们都是异步长任务，内部通过 [WebSocket 进度通道](#_9-plugin-progress-ws-websocket-进度跟踪) 实时推送进度。

同一个插件的安装、更新和卸载操作彼此互斥。如果该插件已经有一个变更操作正在执行，服务端会立即返回 **HTTP 409 Conflict**，不会排队或覆盖现有进度。响应 `detail` 会说明正在执行的操作；客户端应等待当前操作完成后重试。不同插件之间仍可并行操作。

### 安装

**`POST /api/webui/plugins/install`** — 从 Git 仓库克隆并安装插件。请求体：

- **`plugin_id`** — 插件 ID（用于目录命名和 manifest 校验）
- **`repository_url`** — 仓库地址（支持 GitHub 和自定义 Git URL）
- **`branch`** — 分支名，默认 `main`
- **`mirror_id`** — 可选的 Git 镜像源 ID，走镜像加速

服务端会依次克隆仓库、校验 `_manifest.json`（检查 `manifest_version`、`id`、`name`、`version`、`author` 五个必填字段），成功后在 `plugins/` 目录下生成插件目录。

**安装示例：**

::: code-group

```bash [curl 安装插件 ~vscode-icons:file-type-http~]
curl -X POST http://127.0.0.1:8001/api/webui/plugins/install \
  -H "Content-Type: application/json" \
  -H "Cookie: maibot_session=你的Token" \
  -d '{
    "plugin_id": "example-plugin",
    "repository_url": "https://github.com/somebody/example-plugin",
    "branch": "main"
  }'
```

:::

### 卸载

**`POST /api/webui/plugins/uninstall`** — 卸载指定插件。操作前会先禁用插件并通知运行时卸载，然后删除整个插件目录。请求体仅需 `plugin_id`。

### 更新

**`POST /api/webui/plugins/update`** — 更新已安装插件。请求体与安装一致。逻辑分两路：

- **Git 仓库** — 直接 `git pull` 拉取新版本，保留本地 `config.toml` 和 `config_back/` 目录
- **非 Git 目录** — 重新克隆并做备份恢复，`update_mode` 字段为 `reinstall_from_backup`

更新成功后响应包含 `old_version` 和 `new_version` 字段。

## 3. 启用 / 禁用

**`POST /api/webui/plugins/config/{plugin_id}/toggle`** — 切换插件的启用状态。不需要请求体，服务端读取当前 `config.toml` 中 `[plugin].enabled` 的值，取反后写回磁盘。配置变更会自动热更新到对应插件的运行时。

**切换示例：**

::: code-group

```bash [curl 切换启用状态 ~vscode-icons:file-type-http~]
curl -X POST http://127.0.0.1:8001/api/webui/plugins/config/example-plugin/toggle \
  -H "Content-Type: application/json" \
  -H "Cookie: maibot_session=你的Token"
```

:::

响应中 `enabled` 字段反映切换后的新状态，`note` 提示"状态更改将自动热更新到对应插件"。

## 4. Catalog Git 镜像操作

插件市场和镜像源管理端点，围绕 git_mirror_service 展开。

- **`GET /api/webui/plugins/version`** — 返回当前 MaiBot 版本（`version`、`version_major`、`version_minor`、`version_patch`）
- **`GET /api/webui/plugins/git-status`** — 检查本机是否安装 Git，返回 `installed`、`version`、`path`
- **`GET /api/webui/plugins/mirrors`** — 列出所有已配置的 Git 镜像源（每个镜像含 `id`、`name`、`raw_prefix`、`clone_prefix`、`enabled`、`priority`）
- **`POST /api/webui/plugins/mirrors`** — 添加一个新镜像源
- **`PUT /api/webui/plugins/mirrors/{mirror_id}`** — 更新指定镜像源参数
- **`DELETE /api/webui/plugins/mirrors/{mirror_id}`** — 删除指定镜像源
- **`POST /api/webui/plugins/fetch-raw`** — 通过镜像源获取远程仓库的 raw 文件（通常用于拉取插件商店的 `plugin_details.json`）
- **`POST /api/webui/plugins/clone`** — 通过镜像源克隆指定仓库到目标路径

## 5. Plugin Config 编辑

插件配置路由提供结构化、原始 TOML 和重置三种操作。

### 查询配置

- **`GET /api/webui/plugins/config/{plugin_id}/bundle`** — 一次性返回配置页初始化数据：`schema`（配置表单 Schema）、`config`（当前结构化配置）、`raw_config`（原始 TOML 文本）
- **`GET /api/webui/plugins/config/{plugin_id}/schema`** — 仅返回配置表单 Schema
- **`GET /api/webui/plugins/config/{plugin_id}`** — 仅返回当前配置字典
- **`GET /api/webui/plugins/config/{plugin_id}/raw`** — 返回原始 TOML 文本

Schema 优先通过运行时 `inspect_plugin_config` 获取，运行时不可用时自动根据磁盘配置推断一个兜底 Schema。

**查询示例：**

::: code-group

```bash [curl 获取配置 Bundle ~vscode-icons:file-type-http~]
curl -X GET http://127.0.0.1:8001/api/webui/plugins/config/example-plugin/bundle \
  -H "Cookie: maibot_session=你的Token"
```

:::

### 修改配置

- **`PUT /api/webui/plugins/config/{plugin_id}`** — 更新结构化配置（JSON 格式）。服务端会合并到现有配置、通过运行时校验（如可用）、自动备份原文件，然后写入 `config.toml`。支持点号路径的平铺 key（如 `"plugin.enabled": true`）。
- **`PUT /api/webui/plugins/config/{plugin_id}/raw`** — 更新原始 TOML 文本。写入前会校验 TOML 语法合法性，并备份原文件。
- **`POST /api/webui/plugins/config/{plugin_id}/reset`** — 重置插件配置，将原有 `config.toml` 移入备份目录并删除，插件将恢复默认配置。

所有写操作都会自动备份原文件（备份路径包含时间戳），响应中的 `note` 提示"配置更改将自动热更新到对应插件"。

## 6. Runtime Component 查询

这些端点查询插件运行时中已注册的组件、首页卡片和 Hook 规格。

- **`GET /api/webui/plugins/runtime/plugins/{plugin_id}/components`** — 返回指定插件当前注册的 Commands 和 Tools 组件列表，每个组件含 `name`、`description`、`enabled`、`component_type` 以及类型相关的参数/模式字段。
- **`GET /api/webui/plugins/runtime/home-cards`** — 返回所有已启用插件的 WebUI 首页卡片。卡片数据经过截断和链接安全过滤（仅允许 `http:`、`https:`、`mailto:`、`/` 开头的链接），按 `order`、`plugin_id`、`name` 排序。
- **`GET /api/webui/plugins/runtime/hooks`** — 返回当前运行时公开的 Hook 规格清单，每个 Hook 含 `name`、`description`、`parameters_schema`、`default_timeout_ms`、`allow_blocking`、`allow_abort` 等字段。

**组件查询示例：**

::: code-group

```bash [curl 查询插件组件 ~vscode-icons:file-type-http~]
curl -X GET http://127.0.0.1:8001/api/webui/plugins/runtime/plugins/example-plugin/components \
  -H "Cookie: maibot_session=你的Token"
```

:::

> **区分说明** — 本节的组件查询是 API 层面的只读数据拉取，不涉及 Host/Runner 之间的进程通信协议（如 RPC 消息序列化、故障熔断恢复、Runner 生命周期管理等）。后者请参见 [插件运行时内部架构](../plugin-runtime-internals.md)。

## 7. Plugin Icon 获取

**`GET /api/webui/plugins/icon/{plugin_id}`** — 返回插件在 `_manifest.json` 中声明的本地图标文件。图标声明格式为 `display.icon.type = "local"` 且 `display.icon.value` 为插件目录内相对路径。

服务端对图标做多道校验：只允许相对路径（拒绝 `..` 遍历和绝对路径）、限制文件后缀为 `jpg/jpeg/png/svg/webp`、限制文件大小不超过 512 KB。响应头含 `Cache-Control: public, max-age=3600`，适合前端缓存。

## 8. stats_proxy 统计代理

该模块反向代理至外部插件统计服务（默认地址 `http://hyybuth.xyz:10059`，可通过 `MAIBOT_PLUGIN_STATS_BASE_URL` 环境变量覆盖），为 WebUI 前端的插件商店提供点赞、评分、下载计数等功能。所有端点统一超时 8 秒（可通过 `MAIBOT_PLUGIN_STATS_TIMEOUT` 覆盖）。

- **`GET /api/webui/plugins/stats-proxy/stats/summary`** — 插件统计概览
- **`GET /api/webui/plugins/stats-proxy/stats/{plugin_id}`** — 单个插件统计
- **`GET /api/webui/plugins/stats-proxy/stats/user-state?plugin_id=...&user_id=...`** — 查询用户对某插件的点赞/评分状态
- **`POST /api/webui/plugins/stats-proxy/stats/like`** — 点赞（请求体 `plugin_id` + `user_id`）
- **`POST /api/webui/plugins/stats-proxy/stats/dislike`** — 踩
- **`POST /api/webui/plugins/stats-proxy/stats/rate`** — 评分 + 评论（请求体 `plugin_id` + `user_id` + 可选 `rating`/`comment`）
- **`POST /api/webui/plugins/stats-proxy/stats/download`** — 记录插件下载

> **注意** — stats_proxy 各端点不走 Cookie 认证，而是使用 `require_auth` 依赖（`Depends(require_auth)`），在后端内部做鉴权。外部统计服务不可用时返回 HTTP 502。

## 9. plugin-progress WebSocket 进度跟踪

::: warning 这不是 HTTP
plugin-progress 是一个 **WebSocket** 端点，不是 HTTP 请求。不能用 `curl` 调用，需要通过 WebSocket 客户端连接。
:::

### 推荐方式：统一 WebSocket 频道

所有插件进度事件通过 [统一 WebSocket 通道](./realtime-and-stats) 推送，domain 为 `plugin_progress`，topic 为 `main`。这是前端 WebUI 实际使用的路径，无需单独连接插件专用 WebSocket。

鉴权通过 WebSocket 临时 Token（参考 [认证模型](./index.md#_3-websocket-临时-token)），将临时 Token 放在 URL 查询参数 `?token=...` 中即可建立连接。收到推送后每帧格式为：

::: code-group

```json [JSON ~vscode-icons:file-type-json~]
{"topic":"plugin_progress:main","event":"update","data":{"progress":{...}}}
```

:::

`progress` 对象包含当前操作信息：

- **`operation`** — 操作类型：`install` / `uninstall` / `update` / `fetch` / `idle`
- **`stage`** — 当前阶段：`loading` / `success` / `error` / `idle`
- **`progress`** — 进度百分比（0-100）
- **`message`** — 进度说明文本
- **`plugin_id`** — 当前处理的插件 ID
- **`error`** — 错误详情（仅在 `stage=error` 时有值）
- **`total_plugins`** / **`loaded_plugins`** — 批量操作时的计数
- **`mirror_id`** / **`mirror_name`** / **`mirror_index`** / **`total_mirrors`** — 多镜像重试时的镜像信息
- **`attempt`** / **`max_attempts`** — 单镜像内的重试计数

### 旧版直接端点

**`WS /api/webui/plugins/ws/plugin-progress`** — 旧版插件进度 WebSocket（直接连接，不走统一通道）。支持通过 URL 查询参数 `?token=...` 或 Cookie `maibot_session` 进行认证。连接建立后立即发送当前进度快照，之后持续推送增量更新。支持 `ping`/`pong` 心跳保持连接。

> 新集成建议使用统一 WebSocket 通道，旧版仍保留以兼容已有前端。

## 10. 与运行时架构的关系

本文覆盖的都是 HTTP / WebSocket API 层面的操作。当你需要了解这些操作背后的运行时机制（比如 `POST /install` 后插件如何被 Host 加载、Runner 子进程如何 spawn、`PUT /config` 后配置如何热刷新）时，请转到 **[插件运行时内部架构](../plugin-runtime-internals.md)**。那篇文档专门讲解：

- Host / Runner 双进程模型与 spawn 约定
- `_manifest.json` 在运行时中的解析流程
- Runner 子进程生命周期管理与故障恢复
- 配置热更新与运行时校验的实现链路
- 组件注册、Hook 调度与熔断机制

本文的定位是"你发了一个 curl，会发生什么"，runtime-internals 的定位是"插件进程内部到底怎么跑"。二者互补，不必在本文展开。
