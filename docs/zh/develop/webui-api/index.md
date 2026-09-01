---
title: WebUI HTTP API 入口
---

# WebUI HTTP API 入口

本目录现在主要作为历史 MaiBot WebUI API 文档的兼容说明。早期文档仍保留在
`docs/zh/develop/webui-api/*` 下，但 Kaguya 当前运行的服务端接口已经不是其中
描述的 FastAPI `/api/webui/*`、`/api/config/*` 或 `/api/chat/*`。

当前 Kaguya 实际暴露的是基于 Fastify 的 `/api/v1/*` 网关，应以仓库中其余
Kaguya 文档和运行中的 OpenAPI 为准。

## 当前 Kaguya API 面

请使用以下现行接口：

- `GET /api/v1/setup`：返回不含密钥的 setup/readiness metadata，包括
  `status`、`selectedProfileId`、`profiles`，以及需要时的 `issues` 与
  `warnings`
- `GET /api/v1/profiles`：返回 Profile metadata 集合与唯一的
  `selectedProfileId`
- `POST /api/v1/profiles`：创建命名 Profile，但不自动切换
- `GET /api/v1/profiles/:profileId`：按显式 `profileId` 读取完整 Profile
- `PUT /api/v1/profiles/:profileId`：完整替换指定 Profile
- `PUT /api/v1/profiles/selection`：显式修改 `selectedProfileId`
- `DELETE /api/v1/profiles/:profileId`：删除允许删除的非 default、非当前选中
  Profile
- `POST /api/v1/messages`：在配置 ready 后提交运行时消息
- `GET /healthz`：进程存活检查
- `GET /api/v1/openapi.json`：导出当前生成的 OpenAPI 文档

管理类接口要求 Bearer gateway token。`GET /api/v1/setup` 与 `GET /healthz`
保持匿名可访问，以便在任何 Profile 尚未 ready 前仍能展示统一配置页面。

## setup 与重启语义

Kaguya 使用 v3 Profile Registry，并且只有一个显式的 `selectedProfileId`。
在全新配置根中，bootstrap 会创建保留的空 `default` Profile 并把它设为当前选择。
之后，WebUI 将“创建 Profile”“完整替换 Profile”“选择全局 Profile”作为三个明确动作。

选择某个 Profile，或完整替换当前 selected Profile，都会锁存一次重启要求。
只有当当前 selected Profile 已经 ready 时，页面才显示 `restart_required`。
如果它仍处于 `invalid` 或 `review_required`，页面会继续展示 readiness issues，
而不是提示重启。

更底层的配置库 `inspect()` 在 bootstrap 前仍可能返回 `setup_required`。但在正常
Server 启动路径里，Kaguya 会先补齐空 registry，所以用户通常通过
`GET /api/v1/setup` 看到的是 `invalid`、`review_required`、
`restart_required` 或 `ready`。

## 本目录的历史范围

如果本目录其他页面仍讨论 MaiBot 专用的路由组、Cookie 登录流或系统控制端点，
请把它们视为历史参考，不要当成当前 Kaguya 契约。只有明确提到 `/api/v1/*`
并已与现行代码同步的页面，才可作为当前实现依据。

当前运行时与配置模型请优先参考：

- [配置指南](/manual/configuration/)
- [WebUI 指南](/manual/webui/)
- [消息服务器与适配器](../message-server-and-adapters.md)
