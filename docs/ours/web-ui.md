
# Web UI

`apps/web` 是统一 Kaguya Server 内提供的 React/Vite 客户端。它不再运行独立的开发服务，也不接受网关地址配置；健康检查、消息提交和会话查询始终使用同源相对路径 `/healthz`、`/api/v1/messages` 与 `/api/v1/sessions/:sessionId`。

## 启动

```bash
pnpm dev
```

打开 `http://127.0.0.1:3000`。开发模式由 Fastify 内挂 Vite middleware 并在同一端口提供 HMR。生产模式先执行 `pnpm build`，再由 Fastify 提供 `apps/web/dist`。

网关 token 由 Server 在启动时确定：未设置 `KAGUYA_GATEWAY_TOKEN` 时自动生成（日志 `server.token.generated`），页面加载时自动获取，无需手填。

不再使用 `pnpm web`、第二个 5173 端口或 `VITE_KAGUYA_API_URL`。

## 统一配置入口

当 `KAGUYA_CONFIG_ROOT` 尚未初始化、默认 profile 不完整或可选配置尚未确认时，页面会显示统一配置入口，而不是聊天界面。引导页收集 OpenAI-compatible Provider 的 Base URL、API Key、light/heavy 模型 ID；API Key 仅通过受保护的配置接口提交，不会写入浏览器存储。已有但不完整的默认 profile 会通过同一入口修复，不会静默回退到其他配置。

保存成功后页面会提示重启 Server。重启是必要的，因为 Runtime 会在启动时冻结 profile 并创建模型客户端；重启完成后刷新页面即可进入聊天界面。

## 浏览器存储

| 数据         | 存储                                      | 生命周期             |
| ------------ | ----------------------------------------- | -------------------- |
| 网关 token   | 不存储；页面加载时从 Server 自动获取     | 仅当前页面内存       |
| 会话 ID      | `sessionStorage` 的 `kaguya.sessionId`    | 仅当前标签页         |
| Server 地址  | 不存储                                    | 始终使用页面同源地址 |

网关 token 不写入任何浏览器存储，也不应写入 `VITE_*` 环境变量（这类值会被打包进浏览器产物）；它每次页面加载时从 Server 重新获取。

## 当前能力

- 检测统一服务健康状态；
- 在发送前校验 Token、空消息和消息长度；
- 展示提交中、Server 已接受且等待回复、已回复和失败状态；
- 进入聊天时恢复当前标签页的会话历史；
- 通过轮询展示核心层持久化的 `assistant` 回复（左对齐气泡）；
- 展示 API 返回的结构化错误；
- 适配桌面和移动布局。

UI 不接收 provider、模型、API key 或 base URL。模型和工作流由 Server 内 Runtime 管理。

## 响应边界

`202 accepted` 表示消息已持久化：用户消息写入 SQLite 后接口立即返回，LLM 回复在后台生成并由核心层持久化为 `assistant` 消息。页面不伪造机器人回答——回复出现之前只显示「等待回复」状态。

收到 `202` 后，页面每 2.5 秒查询一次 `GET /api/v1/sessions/:sessionId`；当对应 `requestId` 的 `assistant` 消息出现时，以左对齐气泡展示，用户消息从「等待回复」转为「Server 已接收」。轮询在以下任一条件停止：全部未确认请求都收到回复；`202` 后 300 秒仍无回复（气泡标记「等待回复超时」）；或返回 401（停止轮询并显示表单错误）。标签页隐藏时暂停轮询，回到前台恢复。

`sessionId` 存放在 `sessionStorage`，每个标签页独立：同一标签页刷新会恢复历史，第二个标签页开启新会话。Web 会话 ID 只存在于消息 `metadata_json`，不参与平台分组语义，也不是事件 payload 的一部分。

## 排障

- 页面打不开：确认 `pnpm dev` 仍在运行，并检查 `server.start.failed` 或 Vite 启动错误；
- 健康检查失败：确认浏览器访问的就是 `KAGUYA_HOST:KAGUYA_PORT`，页面不支持另填网关地址；
- 返回 401：token 由 Server 分发并在页面加载时自动获取；未显式设置 `KAGUYA_GATEWAY_TOKEN` 时，Server 重启后生成的 token 会变化，刷新页面重新获取即可；
- 页面可用但 NapCat 无响应：检查 `adapter:napcat` 日志；平台连接状态不影响 Web UI；
- 深层页面生产环境 404：确认 `apps/web/dist/index.html` 存在并由 `pnpm build` 生成；
- 回复长时间不出现：先确认 `202` 已返回且用户消息可见，再在 Server 日志中查找 `message.processing.failed`（含 traceId `webui-${requestId}`）与对应 LLM trace；回复生成失败时该会话只会保留用户消息。
