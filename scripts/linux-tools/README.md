# Linux shell 工具

宿主 broker 管理持久 shell job，每个 job 在独立 rootless 容器和 systemd user unit 中执行。控制 manifest、permit、回执与 stdout/stderr 均留在宿主私有目录；任意命令只取得 workspace。桌面 init/helper 仅承担可信组件协议，不执行 shell。到期、stop、关闭或接管必须确认 job 整个 cgroup 与容器已停止；start 的 accepted 与命令 exited 分开。重复 operation 读取同一 job，未知结果不重跑。

`shell.exec` 参数的 mode 为 start、query、stop、verify、export。start 接收绝对可执行文件 argv、workspace 相对 cwd 和独立 env。不会继承宿主环境，禁止通过 env 覆盖 helper 身份。verify 在新 operation 下读取真实文件或原 job 回执，明确携带原 operationId/attemptId；journal reconcile 仍只读 W6 journal。export 限定 workspace 普通文件，拒绝路径穿越与符号链接；stdout/stderr 使用 jobId/stream 引用。附件按单件及原始总额 16 MiB 限制，超限保留完整文件、大小和 hash，可按 offset/maxBytes 分段读取。

新作业由容器 PID 1 监控器返回独立的 `exitStatus`：`exit/code` 或 `signal/number`。`exitCode` 仅表示命令正常退出时的退出码；`signal` 表示 `waitpid` 实际观察到的信号。监控器禁止进程转储，命令 stdout/stderr 只作为数据封装。监控器、传输或协议证据缺失时返回 `unknown`，不能用 128 或 143 推断信号。完成回执仍须确认整个 payload cgroup 已停止。

Server 从敏感配置目录的 `linux-tools.json` 显式启用；文件不存在即关闭。配置样例：

```json
{
  "version": 1,
  "revision": "one",
  "bindings": [
    {
      "scope": "explicit-scope",
      "environmentId": "prepared-environment",
      "workflowId": "explicit-workflow"
    }
  ]
}
```

配置文件权限与 `mcp.json` 相同。环境由宿主管理 API 预先创建，绑定的 scope 不能由模型更改。每次工具 bind acquire/renew 外层 lease；renew 不延长已派发 job 的 permit。当前长 job 到期停止全树，不开放隐式续权。切换配置前排空 Runtime 并关闭工具宿主；恢复隔离环境需要宿主显式 recover。停用不删除 job、profile、文件、产物或 Kaguya 账本。

镜像使用固定 Node 24.18.0 amd64 基础 digest，在构建阶段复制代码，没有运行时下载。CI `Linux tools image` 构建 OCI archive，分别记录 archive SHA-256 与 image manifest digest，上传构建产物，并使用 W6 的生产容器参数执行 rootless ready、写文件、退出及代次恢复验证。CI 临时 runner 与生产 Ubuntu 的 bootstrap、账户、防火墙和存储安装分别验收。镜像导入复用 W6 `image.import`；新增宿主监督模块须纳入最终统一 bootstrap bundle，旧 staging 暂缓执行。

`node --test scripts/linux-tools/check-shell.mjs` 验证可信组件的隔离屏障；Python 专项验证持久身份和真实文件边界。真实容器及独立截止行为由 `check-container.py` 在 Linux runner 验证。当前 shell 镜像不提供 browser/GUI 工具；对应 health 不声明这些能力。Chromium 和实际 sandbox 另行交付。

## Chromium DOM 工具

可信 Chromium 镜像固定 Playwright 1.64.1 所带 Chromium 156.0.8078.4。Playwright 包用于定位浏览器，运行中的 owner 使用私有 `remote-debugging-pipe`；调试地址不开放到 TCP。宿主用 `sandboxPolicy: "chromium-v1"` 创建环境，broker 匹配已审查的 runtime/default-profile hash 并选择对应 seccomp。运行时不下载依赖。Server 对所需 binding 显式添加 `"browser": true` 后，才注册 `browser.observe`、`browser.act`、`browser.verify`。

`observe` 返回当前页面的 DOM 节点、视口、内容 hash 和短期观察引用，可附 JPEG 截图。观察由可信组件保存，绑定 scope、lease、fencing、workflow、generation 和 document；改写返回字段不能改变授权。`act` 只接受一次 navigate、click、fill 或 select；输入后引用即消耗。click 使用 DOM activation，fill/select 使用原生 setter 和合成 input/change 事件。这些 DOM 语义不等同 trusted pointer/键盘；视觉输入由 W8 交付。工具不接受脚本、CDP 方法、宿主路径或任意 profile。

输入函数在独立 world 的同一 renderer 任务里核对完整 HTML、表单属性、视口、URL 和截止时间。准备阶段及每次 pipe 写入另验固定 permit。handoff 先封门、清空旧观察，再等待 connection/session/id 表中的真实 CDP 回执；断连、丢失回执和目标异常保持 unknown/draining，不用 detach 或客户端超时制造成功 ACK。页面、owner PID、未保存输入和 profile 在正常 handoff/resume 中保留；恢复自动化后必须重新观察。已接受输入启动的异步网站业务可能随后完成，使用新 operation 下的 verify 核对，不重复点击。

`verify` 明确引用原 operationId/attemptId；broker 核对原 browser.act 属于同一 scope/environment/workspace。页面核对读取当前 DOM；下载核对要求 `verificationKind: "current-file-state"`，读取私有持久文件的 hash 与范围，不重放输入。下载保留原 URL、报告的 MIME、文件名、时间和原操作关联窗口；回执固定标注 `association=heuristic` 与 `causalAttribution=unconfirmed`，不把文件核对当作原操作造成下载的证明。完整文件在 `/private` 保留，附件仍遵循 16 MiB 总额，可按 offset/maxBytes 分段导出。未知下载不会被当作原操作已完成。

`browser_checks.py` 经生产 broker/helper 驱动单一 owner，使用独立本机站点与 fsync 提交计数验证真实 DOM、下载及页面保留。CI 同镜像默认/候选策略 A/B 读取 Chromium 自身 sandbox 状态，并记录实际 OCI 的非 root、空 capabilities、NNP、只读 rootfs。Ubuntu 24.04 / Podman 4.9.3 的结果与生产 Ubuntu 26.04 / Podman 5.7.0 的现场验收分别记录。

## GUI 桌面与模型续轮

`Dockerfile.gui` 固定 Cua 0.38.0，使用独立 Xvfb 桌面。Driver、控制组件和 Xvfb 运行于 UID 1000；Openbox、GTK、Chromium 和应用会话总线运行于 UID 1001。Cua 只通过私有 stdio 接受观察和基本输入。GUI 环境按 `desktopKind: "gui"` 与 `sandboxPolicy: "chromium-v1"` 创建；桌面限额为 384 tasks，shell jobs 共用 112 tasks，环境总限额仍为 512 tasks / 4 GiB。持久应用 HOME 位于 `/private/app`。

在 `linux-tools.json` 的 binding 中添加 `gui: true`，即可管理该桌面的人工会话。启用原生 GUI 工具还需显式指定 `guiModel`。例如：

```json
{
  "scope": "[\"web\",\"web.main\",\"private\",\"example-user\"]",
  "environmentId": "prepared-gui-environment",
  "workflowId": "approved-workflow",
  "gui": true,
  "guiModel": {
    "routeId": "gui.approved",
    "providerId": "approved-provider",
    "modelId": "approved-vision-model"
  }
}
```

使用宿主实际生成的 scope，并选择当前 Profile 内已配置的 provider。Server 为管理入口创建的独立 `agent.gui.execute` 任务选择这条路由。同一 scope 的普通 `agent.heavy.respond` 继续使用聊天模型，其工具目录不包含 `gui.observe`、`gui.act` 或 `gui.verify`。GUI 路由沿用 Profile 的 Heavy generation 设置。凭据只来自 Profile；配置摘要包含适配器、协议、无凭据的 endpoint 和 generation 设置。原生绑定要求 endpoint 的凭据与查询参数为空，API key 使用独立字段。

`gui.observe` 返回桌面或指定窗口的原始 PNG、capture ID、原图尺寸、坐标系、窗口原点及短期观察引用。`gui.act` 接受一次元素或像素点击、ASCII 插入、完整字段 Unicode 替换、按键或滚动；插入和按键必须使用目标窗口的观察引用。引用绑定当前 lease、generation 和会话，输入后消费，交接后必须重新观察。执行前重新核对同一目标的截图和语义状态；检查后的应用变化仍可能发生。所有输入在共享桌面的前台执行。`gui.verify` 引用原 operationId/attemptId，读取当前 GUI 状态；原操作的 unknown 记录保持不变。

原生循环把整批工具结果保存在 tool 消息中，再追加对应原图。实时续轮和重启恢复读取同一个不可变 blob，并核对 scope、intent、generation、哈希和尺寸。图片与完整工具交互一同裁剪；base64、元数据和最终 HTTP JSON 均受输入字节预算约束。run 身份固定为 activation、task 和 source；模型路由与非秘密配置在首轮冻结。重启后更改模型、配置、路由或关闭 native，会停止原 run 并保留已有回执。旧 run 的来源仅从真实 requested 事实恢复；缺少模型绑定时停止推进，已有终态仍可读取。

## GUI 管理 HTTP 接口

以下路径相对于 `/api/v1/environments/:environmentId`。列表入口为 `GET /api/v1/environments`。所有接口使用 Gateway management Bearer 认证并返回 `Cache-Control: no-store`；这是共享管理员权限。scope 由宿主 binding 决定。浏览器只持有公开的 sessionId/generation，人工输入凭据保留在服务端。

| 方法与路径                           | 请求内容或用途                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| `POST /tasks`                        | `{taskRequestId, prompt}`；UUID 固定任务身份，返回 202 与持久请求 ID               |
| `GET /tasks/:taskRequestId`          | 查询同一任务、run 与完成/失败/停止状态                                             |
| `POST /tasks/:taskRequestId/cancel`  | 空请求体；持久取消该任务并沿用现有模型/W3 停止协议                                 |
| `GET /control`                       | 当前控制状态、generation 和公开人工会话信息                                        |
| `POST /handoff`                      | `{generation, controlAuthorizationId}`；后者为本次交接的 UUID                      |
| `POST /resume`                       | 同上；确认排空人工输入后恢复自动化                                                 |
| `POST /human/observe`                | `{generation, sessionId, operationId, arguments}`；arguments 为 `gui.observe` 参数 |
| `POST /human/input`                  | 同上；arguments 为 `gui.act` 参数                                                  |
| `POST /human/verify`                 | 同上；arguments 为 `gui.verify` 参数                                               |
| `POST /human/renew`                  | `{generation, sessionId}`；只延长后续许可，不延长在途输入                          |
| `POST /human/close`                  | `{generation, sessionId}`；撤销人工输入，保持人工模式                              |
| `GET /human/operations/:operationId` | 查询原操作与 attempt 的持久结果，不重新输入                                        |
| `GET /images/:artifactId`            | 经认证读取已归档 PNG 原字节，不接受 URL token                                      |

GUI 任务要求对应 scope 已有完整、有效的冻结观察，并要求环境处于 ready。宿主冻结 observation、scope、workflow、generation、激活和明确的模型路由；客户端不能指定 origin、nativeStep 或模型选择策略。HTTP 断连后任务继续由现有可靠投递队列处理；同环境与 taskRequestId 的重提返回原任务，提示词冲突返回 409。取消先于 run 创建时，持久取消事实阻止后续模型和工具派发；执行已开始时，保留实际回执与 unknown。查询中的 cancellation 单独报告 pending 或 forwarded；可靠消费者会在重启和转发失败后继续处理 pending，即使 GUI 任务已是 stopped。forwarded 只表示请求已送达，不表示物理效果已撤回。重启后的取消按当前配置取得控制租约，并保留原 attempt 身份；环境拒绝租约时保持 pending，等待管理员显式恢复。human、draining 或隔离未确认状态下提交会被拒绝，恢复自动化须单独调用 resume。配置或环境代次改变会停止原任务，不为旧任务自动切换模型或重新取得新代次执行权。

人工操作的 operationId 使用 UUID。同一操作丢失响应时，保留原 ID 并查询结果；同 ID 重复请求共用原 attempt，不派发第二次输入。交接先阻止新输入，再终止控制进程组、释放按键和鼠标、恢复借用键码，最后确认隔离。正常 handoff/resume 保留应用 PID 与未保存状态。到期或关闭先撤销输入权限，隔离未确认时保留清理归属并拒绝继续输入；恢复自动化始终需要显式 resume。

`check-gui-provider.py` 经生产 Broker、PodmanBackend、ToolService、GuiComponent 和 Cua 验证真实 GTK、原图归档、丢回执去重、人工接管及既存 HOME 恢复。`native-tool-loop.test.ts` 验证原点和模型冻结；`native-tool-results.test.ts` 与 `native-gui-wire.test.ts` 验证图片配对、原字节恢复和最终 SDK 请求体。模型与管理入口联通测试使用合成响应，不产生外部模型请求。真实模型管理 API→GUI 闭环留待 W11 统一联调，由父会话单独分配 USTC 调用额度。
