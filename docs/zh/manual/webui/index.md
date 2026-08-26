# Web UI

`apps/web` 是统一 Kaguya Server 内提供的 React/Vite 客户端。它不再运行独立的开发服务，也不接受网关地址配置；健康检查和消息提交始终使用同源相对路径 `/healthz` 与 `/api/v1/messages`。

## 启动

```bash
export KAGUYA_GATEWAY_TOKEN="replace-with-at-least-16-characters"
pnpm dev
```

打开 `http://127.0.0.1:3000`。开发模式由 Fastify 内挂 Vite middleware 并在同一端口提供 HMR。生产模式先执行 `pnpm build`，再由 Fastify 提供 `apps/web/dist`。

不再使用 `pnpm web`、第二个 5173 端口或 `VITE_KAGUYA_API_URL`。

## 统一配置入口

当 `KAGUYA_CONFIG_ROOT` 尚未初始化、默认 profile 不完整或可选配置尚未确认时，页面会显示统一配置入口，而不是聊天界面。引导页收集 OpenAI-compatible Provider 的 Base URL、API Key、light/heavy 模型 ID，以及网关访问令牌；API Key 仅通过受保护的配置接口提交，不会写入浏览器存储。已有但不完整的默认 profile 会通过同一入口修复，不会静默回退到其他配置。

保存成功后页面会提示重启 Server。重启是必要的，因为 Runtime 会在启动时冻结 profile 并创建模型客户端；重启完成后刷新页面即可进入聊天界面。

## 浏览器存储

| 数据         | 存储                                      | 生命周期                                    |
| ------------ | ----------------------------------------- | ------------------------------------------- |
| Source ID    | `localStorage` 的 `kaguya.sessionId`      | 兼容 API 字段；Core 不赋予 session/历史语义 |
| Bearer Token | `sessionStorage` 的 `kaguya.gatewayToken` | 仅当前标签页会话                            |
| Server 地址  | 不存储                                    | 始终使用页面同源地址                        |

Token 不应写入 `VITE_*` 环境变量，因为这类值会被打包进浏览器产物。

## 当前能力

- 检测统一服务健康状态；
- 在发送前校验 Token、会话 ID、空消息和消息长度；
- 展示提交中、Server 已接受和提交失败状态；
- 展示 API 返回的结构化错误；
- 适配桌面和移动布局。

UI 不接收 provider、模型、API key 或 base URL。模型和工作流由 Server 内 Runtime 管理。

## 响应边界

消息 API 保留 `202 accepted`，没有回复查询或 SSE，因此页面只展示提交状态，不伪造机器人回答。Runtime 会把确定性回复写入同一 SQLite；只有平台入站携带 reply sender 时，工作流才把回复投递到平台。

## 排障

- 页面打不开：确认 `pnpm dev` 仍在运行，并检查 `server.start.failed` 或 Vite 启动错误；
- 健康检查失败：确认浏览器访问的就是 `KAGUYA_HOST:KAGUYA_PORT`，页面不支持另填网关地址；
- 返回 401：页面中填写的 Token 必须与 Server 的 `KAGUYA_GATEWAY_TOKEN` 完全一致；
- 页面可用但 NapCat 无响应：检查 `adapter:napcat` 日志；平台连接状态不影响 Web UI；
- 深层页面生产环境 404：确认 `apps/web/dist/index.html` 存在并由 `pnpm build` 生成。
