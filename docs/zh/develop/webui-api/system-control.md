---
title: 系统控制
---

# 系统控制

本页现在是历史说明。旧版 MaiBot 文档中提到的
`/api/webui/system/*` 运维端点，并不是 Kaguya 当前 Fastify 网关的一部分。

## Kaguya 当前实际暴露的能力

当前可用的 HTTP 接口主要是：

- `GET /healthz`：存活检查
- `GET /api/v1/setup`：匿名查看 readiness 与 selected Profile metadata
- `GET /api/v1/openapi.json`：导出当前 OpenAPI
- 受鉴权保护的 `/api/v1/profiles*`：Profile 管理
- 受鉴权保护的 `POST /api/v1/messages`：Runtime 消息入口

仓库当前没有为旧版公开的 `/api/webui/system/restart`、
`/api/webui/system/reload-config`、缓存清理或更新公告接口提供等价的现行
Kaguya HTTP 文档。

## 运维含义

切换 selected Profile，或完整替换当前 selected Profile，并不会热切换 Runtime。
当 selected Profile 已 ready 后，WebUI 会显示 `restart_required`；运维侧应通过
自己的进程管理方式重启 Kaguya，使下一次启动重新冻结新的全局 Profile。

如果 selected Profile 仍不完整，`GET /api/v1/setup` 会继续返回 readiness
issues，页面不会先提示重启。

## 历史说明

如果你需要研究旧版 MaiBot 的 system-control 设计，请仅将其作为迁移或对照材料。
除非服务端代码重新引入这些路由并同步更新文档，否则不要针对这些历史路径编写
Kaguya 自动化脚本。
