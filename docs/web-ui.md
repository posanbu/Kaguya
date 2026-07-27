# Web UI

`apps/web` 是 Kaguya 应用 API 网关的初版浏览器客户端。它提供网关地址、Bearer Token、会话 ID 和消息输入，并调用 `POST /api/v1/messages`。

## 当前能力

- 网关地址和会话 ID 保存在浏览器 `localStorage`；
- Bearer Token 仅保存在当前标签页所属的 `sessionStorage`；
- 可通过公开的 `GET /healthz` 检测网关连接状态；
- 发送前校验连接配置、会话 ID、空消息和消息长度；
- 展示消息提交中、网关已接收和提交失败状态；
- 展示网关返回的结构化错误，并对未授权、限流和核心层未接入提供明确状态；
- 支持桌面和移动端布局。

UI 不接收模型、Provider、API key 或模型 Base URL。消息通过网关校验后交给 `MessageIngress`，后续模型选择和工作流属于核心层职责。

## 启动

先启动 API 网关：

```powershell
. .\scripts\use-kaguya-env.ps1
$env:KAGUYA_GATEWAY_TOKEN = "replace-with-at-least-16-characters"
pnpm api:dev
```

再打开另一个终端启动 Web UI：

```powershell
. .\scripts\use-kaguya-env.ps1
pnpm web
```

默认访问地址为 `http://127.0.0.1:5173`。页面默认连接 `http://127.0.0.1:3000`，也可以通过 `VITE_KAGUYA_API_URL` 修改默认网关地址：

```powershell
$env:VITE_KAGUYA_API_URL = "http://127.0.0.1:3000"
pnpm web
```

不要通过 Vite 环境变量写入网关 Token，因为 `VITE_*` 的值会打包到浏览器代码中。

## 当前边界

网关启动入口目前尚未注入真实 `MessageIngress`，所以合法消息会收到 `503 core_unavailable`。UI 会显示“核心消息入口尚未接入”。这不是浏览器连接失败；需要核心层实现并在 API composition root 注入 ingress 后，消息才能被正式接受。

当前接口只有提交结果，没有消息查询或 SSE 响应通道，因此 UI 不会伪造机器人回复。后续应在核心层提供持久 run、结果查询和可重连事件流后再扩展对话响应。
