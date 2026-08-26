# Kaguya

Kaguya 是一个事件驱动、模块可插拔的 TypeScript AI Bot Runtime。它以一个长期运行的 Server 进程提供 Web UI、HTTP API 和可选的平台连接，并通过共享 Runtime 处理消息、事件、LLM 调用与出站传输。

## 快速开始

需要 Node.js 24.18.0 和 pnpm 11.9.0。

```bash
corepack enable
pnpm install
export KAGUYA_GATEWAY_TOKEN="replace-with-at-least-16-characters"
export KAGUYA_CONFIG_ROOT="/absolute/path/to/kaguya-config"
pnpm dev
```

打开 `http://127.0.0.1:3000`。生产运行前先执行 `pnpm build`，再使用 `pnpm start`。

## 文档入口

- [架构说明](./develop/)
- [统一 Server 与 HTTP API](./develop/message-server-and-adapters.md)
- [LLM Client](./develop/llm-providers.md)
- [配置引导与网关白名单](./manual/configuration/)
- [Web UI](./manual/webui/)
- [结构化日志](./develop/observability.md)
- [仍需人工实现的部分](./faq/)

## 核心边界

- Runtime 不拥有 session，也不根据私聊、群聊或用户字段隔离历史。
- 入站消息先落库并发布事件，再由模块自行过滤、组织上下文和选择出站目标。
- Provider、模型和密钥由服务端配置管理，不从浏览器或公开消息 API 透传。
- NapCat 是可选连接，断线不会影响 HTTP 与 Web UI。
