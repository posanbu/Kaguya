# Web UI

`apps/web` 是 Kaguya 应用 API 网关的浏览器客户端。当前版本参考 AstrBot 控制台的信息架构，采用左侧工作区导航、中央消息区域和右侧连接设置抽屉，但仍严格遵守 Kaguya 的网关边界：浏览器只提交消息，不选择模型、provider 或 workflow。

## 界面结构

- 左侧栏显示品牌、当前会话、消息数量、网关状态、网关地址和会话 ID；
- “新建会话”会生成新的 `sessionId`，并清空当前浏览器中的消息列表；
- 顶部工具栏显示当前位置、连接状态和连接设置入口；
- 中央工作区显示待提交、网关已接收和提交失败三种状态；
- 连接设置抽屉统一管理网关地址、Bearer Token、会话 ID 和健康检查；
- 小于 `760px` 的视口将侧栏折叠为移动端抽屉，保留完整的消息与设置操作；
- 图标按钮提供 `title` 和无障碍标签，系统启用“减少动态效果”时会停用非必要动画。

“清空消息”只清理页面内存中的展示记录，不删除网关、核心层或数据库中的数据。当前页面没有历史消息查询接口，因此刷新页面后也不会恢复消息列表。

## 当前能力

- 网关地址和会话 ID 保存于浏览器 `localStorage`；
- Bearer Token 仅保存于当前标签页所属的 `sessionStorage`；
- 通过公开的 `GET /healthz` 检测网关连接状态；
- 发送前校验连接配置、会话 ID、空消息和消息长度；
- 使用 `POST /api/v1/messages` 提交 `{ sessionId, text }`；
- Enter 发送消息，Shift + Enter 输入换行；
- 展示结构化网关错误，并对未授权、限流和核心层未接入提供明确状态；
- 网关成功接收消息后显示缩略 `requestId`，便于后续关联日志。

UI 不接收模型、provider、API key 或模型 Base URL。消息通过网关校验后交给 `MessageIngress`，后续模型选择和工作流属于核心层职责。

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

默认访问地址为 `http://127.0.0.1:5173`。页面默认连接 `http://127.0.0.1:3000`，也可以在启动 Web UI 前通过 `VITE_KAGUYA_API_URL` 修改默认网关地址：

```powershell
$env:VITE_KAGUYA_API_URL = "http://127.0.0.1:3000"
pnpm web
```

不要通过 Vite 环境变量写入网关 Token，因为 `VITE_*` 的值会打包到浏览器代码中。Web UI 的 Token 输入框应填写 `KAGUYA_GATEWAY_TOKEN` 的原始值，不要手动添加 `Bearer ` 前缀。

## 验证

```powershell
pnpm --filter @kaguya/web typecheck
pnpm exec vitest run apps/web/src/api.test.ts
pnpm --filter @kaguya/web build
```

构建产物输出到 `apps/web/dist`。桌面端和移动端布局可分别使用 `1440x900` 与 `390x844` 视口进行人工检查。

## 当前边界

本地开发入口现在会注入确定性的 `MessageIngress`，所以合法消息会返回 `202 accepted` 并写入本地 SQLite。该入口只用于开发闭环验证；它没有持久队列、真实平台发送、真实模型策略、结果查询或 SSE，因此 UI 仍不会伪造机器人回复。

当前接口只有提交结果，没有消息查询或 SSE 响应通道，因此 UI 不会伪造机器人回复。后续应在核心层提供持久 run、结果查询和可重连事件流后，再扩展实时对话响应、历史会话和运行详情。
