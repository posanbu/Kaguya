# MCP 客户端

Server 将启用的 MCP 工具注册到现有 Heavy 工具循环和 W3 行动执行器。每个模型步骤仍只生成一次；MCP 客户端负责协议、连接、发现及内容来源，不运行另一套模型循环。

## 配置与启用

`<configRoot>/mcp.json` 缺省不存在，等价于关闭。配置文件与其他宿主配置一样仅由当前用户读写。修改文件后重启 Server；已有配置应用导致 Runtime 重建时也会重读文件。不会联网安装 MCP 服务端。

```json
{
  "version": 1,
  "connections": [
    {
      "id": "example",
      "revision": "r1",
      "enabled": true,
      "protocol": "2025-11-25",
      "transport": {
        "type": "http",
        "url": "https://mcp.example.org/mcp",
        "headerRefs": { "Authorization": "EXAMPLE_MCP_AUTHORIZATION" }
      },
      "scopes": ["[\"qq\",\"napcat.qq.main\",\"group\",\"123456\"]"],
      "tools": [{ "name": "search", "readonly": true, "independent": true }],
      "resourceUriPrefixes": ["example://public/"],
      "prompts": ["summarize"],
      "timeoutMs": 30000,
      "maxPages": 16,
      "maxItems": 256,
      "maxBytes": 1048576
    }
  ]
}
```

环境变量 `EXAMPLE_MCP_AUTHORIZATION` 包含完整 header 值，如 `Bearer …`。配置仅保存引用名。stdio 的 transport 使用 `{ "type": "stdio", "command": "/absolute/server", "args": ["mcp"], "envRefs": { "SERVICE_TOKEN": "MY_SERVICE_TOKEN" } }`，可设置明确的 `cwd`。命令以 `shell=false` 启动，仅继承 PATH、Windows 系统/临时目录及显式配置的环境变量。URL 不接受用户信息、query 或 fragment；HTTP 明文仅允许回环地址，重定向不跟随。

`scopes` 是 W4 的明确平台范围：JSON 数组依次为 platform、adapterId、destination.kind、目标 ID。Web 最后一项是 UUID conversationId。没有通配符。模型只能给出工具参数，不能改变 endpoint、headers、command、环境变量、scope 或白名单。远端 annotations 不授予只读或并行权限。

任何认证身份、权限、凭据或本地策略变化，即使引用环境变量的名称不变，也必须递增连接 `revision` 并受控重建 Runtime。同一连接对象会拒绝凭据值发生变化后的重连；跨进程的身份修订由可信管理员维护。秘密不写入定义、普通日志或 Information 回执。

## 协议与冻结目录

生产依赖锁定 `@modelcontextprotocol/client@2.3.1`、`ajv@8.20.0`，Node 要求为仓库规定的 24.18.0。SDK 包为 Apache-2.0，所附 LICENSE 同时保留早期 MIT 贡献条款。固定来源：[版本清单](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.1/packages/client/package.json)、[许可证](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.1/LICENSE)。

每条连接只能显式选择 `2025-06-18`、`2025-11-25` 或 `2026-07-28`。两个 2025 profile 使用 legacy initialize；现代 profile 固定该版本的 discover。版本不匹配拒绝，不自动降级。stdio 的 discover 与会话共用一个进程，没有探测兄弟进程。

tools/list 使用单页协议 request。整个发现过程受总 deadline、页数、条目数和字节数限制，完成验证后原子发布。JSON Schema 原文保留，支持 draft-07 和默认的 2020-12；不能解析的 schema 使发现失败。输入校验不补默认值、不转换类型、不删除字段，也不请求外部 schema。

定义摘要绑定连接修订、协议、远端原名、输入/输出 schema 和本地策略。W4 冻结声明、wire mapping 及执行 binding。重连不会改写旧 run；执行前再次核对摘要。已经到达的目录变化通知只使目录失效，不启动后台刷新或监听流。显式 reconnect 发布新快照，新的 Runtime 可采用它，旧定义继续保留自己的版本。

现代 HTTP 固定传入 toolDefinition，关闭 SDK 在 HEADER_MISMATCH 后刷新并重发的路径。多轮输入自动处理、OAuth、sampling、elicitation、roots、tasks、subscriptions 和自动 SSE 恢复均未启用。现代 HTTP 不使用旧版 session/GET 恢复；新连接不会继承旧 session 身份。

## 行动结果与资源

W3 在发送前持久登记 intent/attempt。返回的 JSON-RPC ID 与模型 toolCallId、operationId、attemptId 分开保存。断连、输出验证失败、取消或超时保留 unknown；isError 保留 partial 与实际返回，均不自动重发。MCP 没有通用的已执行操作查询接口；unknown 由 W3/管理端核对。取消通知或中断 HTTP 流仅表示停止等待，不能证明远端副作用已停止。

HTTP 认证引用的完整头值及 Bearer/Basic 参数按派发时凭据集合脱敏，覆盖响应正文、JSON 键和迟到证据。工具明确返回 `isError` 时保留错误格式及 `partial/returned`；成功结果仍按冻结的输出 schema 校验，缺失或不匹配时保留 `unknown`。

内容信封保留连接与定义修订、scope、获取时间、原始内容/URI/媒体类型，标记 `untrusted-mcp-data`。它不会成为 system 指令或权限。resources 仅按需 list/templates/read，模板展开后的 URI 仍受前缀策略约束。prompts/get 消耗一次性的用户选择，不能通过工具参数制造该选择。

模块可使用 `mcp:resources`、`mcp:prompts` capability；后者只有 list/get，不提供 select。可信管理端通过 `POST /api/mcp/read` 访问，要求 Gateway management Bearer token，正文包含 connectionId、scope 和 kind。kind 为 resources、templates、prompts、resource 或 prompt；resource 另给 uri；prompt 另给 name/arguments，该 POST 本身是明确用户选择。没有执行任意工具、修改连接或隐式读取资源的 HTTP 路由。

## 生命周期、验证与回退

关闭时先停止 Runtime 新推进，再中断 MCP 请求并回收本组件启动的 stdio 进程树。POSIX 使用独立进程组，发信号前核对当前组成员继承的随机 ownership 标记；身份变化或无法读取时保留记录并报告未确认。Windows 在根进程仍存活时用系统 taskkill /T 回收普通派生树。Windows 根进程提前退出时无法从该 PID 确认完整派生树，返回 cleanup failure，并保留所有权记录。主动逃离受管进程组的服务须由 W6 隔离边界管理。

Server 在 `<configRoot>/mcp-processes` 保存 PID、进程组、宿主 PID、平台和启动时间，不保存命令参数或凭据。只有确认回收后才删除记录；宿主异常退出后的记录用于定位与核对，不能把历史 PID 无条件当作当前可杀进程。清理失败保留 owner，后续 shutdown 继续尝试；不另建全机进程追踪器。

`packages/mcp/src/host.test.ts` 用独立 Node 进程验证三个协议和真实 stdio/HTTP（JSON、SSE）、分页、鉴权、目录变化、取消晚到与退出。`apps/server/src/mcp-host.test.ts` 验证完整 Server→Heavy→W3→MCP→回复，使用 PGlite 或显式 PostgreSQL schema。它们进入 critical 门禁，Server 文件同时进入 PostgreSQL 清单。历史 `.worktrees` 保留在磁盘，排除出当前测试收集。

CuaDriver 0.38.0 的真实兼容验证与合成 2025-06-18 协议测试分别记账。当前 Linux 无特权网络命名空间不可用；真实 Cua discovery 留待 W8/W11 在隔离环境执行，不连接用户真实桌面。

回退先关闭连接配置并停止新 run，排空 Runtime 后回收 MCP。保留 W3 intent/attempt/receipt、W4 call/result、来源信封、unknown 和未确认回收的所有权文件。没有数据库迁移、历史回填或删除旧事实的操作。

### 晚到响应证据

取消或超时后的 `unknown` 回执保持不变。只有 transport 实际收到、能匹配原已发送 `tools/call` 的响应，才写入独立的 `mcp.client.late-result.v1` Information。HTTP 已中断且未收到的正文不能作为客户端观察结果。每个 transport 使用独立 generation；JSON-RPC ID 按原类型匹配，未知 ID 与重连后的同号请求不会关联到旧请求。

证据携带 `scopeKey`、原 intent/operation/attempt/model call ID、冻结的连接/定义 revision、接收时间和脱敏响应摘要。Server 复核原 W3 intent/attempt 后 append，允许证据先于 unknown 提交；不调用改变 W3 head 的完成或核对接口。保存失败保留同一事件 ID，关闭等待保存并在失败时保留宿主和数据库供显式重试；已提交的同一事实只读确认，不重复 append 或重发工具。凭据按派发时上下文脱敏，响应仍受 `maxBytes` 限制。回退时保留已写入的 Information Kind 与事实。

### 人工核对入口

管理端用 Gateway management Bearer token 读取 `GET /api/v1/inspection/actions/{intentId}?scope={编码后的原scope}`，核对原 intent/attempt、unknown 回执及 `lateEvidence` 的原请求身份和摘要。未认证请求返回 401，不匹配的 scope 返回 404。此查询只读，不发送 MCP 请求、不触发工具重试、不改变行动状态。服务端已产生副作用但 HTTP 响应未到达客户端时，页面没有迟到证据是正常结果，不能据此确认未执行。

通用 MCP provider 的 `reconciliation` 保持 false。该入口供人检查已有证据，没有人工填写成功状态的写接口，也不以客户端迟到响应代替远端副作用核对。只有具体服务提供可信查询能力并接入 W3 provider 后，才能据该证据执行状态核对。

## 合成服务的控制与等待

`@kaguya/mcp/testing` 的合成服务通过独立、随机令牌保护的回环控制 socket 应用完整状态，宿主用 `applySyntheticControl` 等待配对 ACK。`state.json` 只用于新进程启动，不监听文件事件；已运行服务不会在写入中间状态时读取它。控制端点只写测试 journal，不进入 MCP 目录、注册项或生产配置。服务按原 method/RPC ID 记录 `held`、`released` 和 `control-applied`。控制 ACK 明确表示状态已应用与哪些 barrier 已释放，不能代替 MCP 请求自身的完成。

结构性 hold 用例采用 fixture-only 16 秒连接/请求预算，8 秒观察与 2 秒控制 ACK 留出 6 秒响应余量；500 ms 实际 HTTP deadline 专测保持原预算。`fixtureBudget` 保守累加 body 上限：ready 8 秒 + 每个 open/reconnect 的握手、分页发现各一份 timeout + 每个 RPC 一份 timeout + 每次观察8秒 + 每次控制ACK2秒 + 每次显式close5秒 + 文件I/O5秒。并行于RPC的观察仍单列，不依赖阶段间借用余量。afterEach清理另有20秒上限。

| 控制用例                        | connections | calls | polls | controls | closes | body上限 |
| ------------------------------- | ----------: | ----: | ----: | -------: | -----: | -------: |
| 延迟 reconnect 旧 provider 拒绝 |           2 |     0 |     1 |        2 |      0 |     89秒 |
| cancel 与迟到，含重连           |           2 |     1 |     3 |        1 |      0 |    119秒 |
| 两代 late RPC                   |           2 |     2 |     4 |        3 |      1 |    152秒 |
| late 保存失败后 close 重试      |           1 |     1 |     2 |        1 |      2 |     89秒 |
| 半写状态且无 watch 通知         |           1 |     1 |     1 |        2 |      0 |     73秒 |
| release 已应用但 ACK 丢失       |           2 |     0 |     1 |        3 |      0 |     91秒 |

500ms专测的两次恢复观察和控制ACK另行计入32.5秒body，未改变实际请求deadline。普通3秒配置下，schema重连、通知、凭据和错误后重连也按同一账本计算。Server晚到fixture沿用其原有分阶段预算，并使用相同ACK控制。清理单独释放控制并等待原工作；主断言、控制 ACK 或原工作任一失败都保留诊断，不跳过后续清理。关闭后的清理仅在确认受控进程已退出时允许端点缺席。

确定性回归在服务 hold 后留下半份 JSON，不发送文件通知，再用控制 ACK 释放真实 stdio/HTTP RPC；另模拟状态已应用但 ACK 丢失，验证原 discovery 仍收敛且主错误与 ACK 错误均保留。完整 MCP 文件及消费该服务的 Server/Linux 组合文件共同验收，不以重复跑绿作为修复证据。

## Server fixture 的因果等待

`apps/server/src/mcp-host.test.ts` 以HTTP响应的requestId找到原入站I，核对同目标的Identity terminal、candidate/claim及turn context T；Web身份允许 `unresolved/ephemeral`。Router的冒号scope与MCP的JSON tuple分开核验。第二阶段确认同T的Situation与同candidate的Attention observe；第三阶段确认以T为source的Light request、配对completion、获胜decision及Heavy intent。引用和Runtime context贯穿校验，不读取最新无关事件。stdio/HTTP正式链路、同scope GUI聊天及两种late用例共用同一局部helper。

各持久里程碑沿用8秒/20毫秒条件等待。失败诊断保留backend、worker PID/ID、各阶段耗时、活动阶段、原input/turn/candidate/claim/request ID和Light/Heavy/GUI计数，不记录prompt或凭据。setup和close按真实Promise记录；没有新增会遗弃初始化Promise的race。测试mcp.json显式记录原有默认30秒I/O预算，保持原fixture请求语义；生产默认、全局helper和MCP专用deadline测试不变。

正文预算保守累加：每轮setup=HTTP ready8秒+文件/数据库15秒+MCP握手30秒+目录发现30秒+Runtime bootstrap15秒=98秒；每段持久等待8秒、每次显式close20秒、每次管理端MCP读取30秒、每次控制ACK2秒，另留文件I/O5秒。

| 用例                         | setup轮数 | 等待段 | close次数 | MCP读取 | ACK | 正文上限 |
| ---------------------------- | --------: | -----: | --------: | ------: | --: | -------: |
| stdio/HTTP正式链路           |         1 |      6 |         1 |       2 |   0 |    231秒 |
| 同scope聊天/管理GUI          |         1 |      6 |         1 |       0 |   0 |    171秒 |
| Runtime关闭失败/部分启动失败 |         1 |      0 |         1 |       0 |   0 |    123秒 |
| MCP关闭失败重试              |         1 |      0 |         2 |       0 |   0 |    143秒 |
| 候选Runtime重建失败          |         2 |      0 |         2 |       0 |   0 |    241秒 |
| late before/after unknown    |         1 |  最多7 |         1 |       0 |   2 |    183秒 |
| 确定性Light gate             |         1 |      8 |         1 |       0 |   0 |    187秒 |

cleanup按fixture owner关联。hook独立上限130秒：gate release/observer settle16秒、fixture宏阶段100秒、Linux辅助5秒和余量9秒。fixture宏阶段为Server close20秒、最多两个真实MCP owner各8秒、失败时真实Runtime close20秒及原Server close settlement16秒、数据库10秒、HTTP child退出8秒、文件5秒，合计95秒并留5秒串行开销。真实MCP owner通过原公开close能力回收，再只读确认PID退出；不向裸PID发送终止信号。超时Server.close不被当作已经结算，fallback在DB关闭前执行。此前同fixture的gate/auxiliary错误也会阻止删除诊断目录；其他fixture不继承该错误。

受控清理探针使Server.close等待gate，同时注入辅助清理错误；它确认stdio owner独立退出后释放gate，等待原close完成，验证两类错误均保留且真实资源已关闭。其正文预算为setup98秒+一次观察8秒+两次有界cleanup结果等待各130秒+两次原close settlement各16秒+I/O5秒=403秒。另一探针用两个未启动Server的独立DB/file fixture验证保留边界，预算为两轮文件/DB各15秒、DB close各10秒、file close各5秒、辅助5秒和I/O5秒=70秒。正常body和hook预算不互相借用。

Light gate只阻塞合成模型响应。held时独立读取共享readiness predicate，确认同turn的requested=1而completion/decision/intent=0且Heavy/effect仍0；释放后才启动独立8秒完成等待。release与observer settlement在正文finally和清理兜底中分别处理。该检查不使用固定sleep。历史首轮失败与避开lint的对照分别保留；一次通过不作为唯一资源根因的证明。

## stdio进程组退出与清理诊断

POSIX进程组身份核验返回`gone`、`owned`或`unconfirmed`。只有当前组探测返回`ESRCH`才确认gone；`pgrep`空结果、`EPERM`或身份不可读均不能充当退出证据。每轮按指定PGID读取成员S1、读取这些成员的PID/PGID及owner标记，再读取全组S2。S1/S2变化时丢弃该轮所有身份结果，在同一5秒close deadline内重新全验。`ps`非零也继续取得S2和组状态，因为已退出成员可以使查询失败；稳定存活而身份不可读或owner不匹配时拒绝发信号并保留ownership record。

SIGTERM与SIGKILL分别核验当前全组。核验后signal返回ESRCH时再次确认整组消失，并等待直接子进程被reap。signal后的drain先在原阶段预算内等待根exit，再观察剩余组；该顺序不将EPERM视为gone。已发送合法信号后的drain遇到EPERM时只在原阶段预算内继续只读观察，随后必须明确得到ESRCH才确认退出；持续EPERM拒绝升级信号并保留记录。每次查询和信号前检查剩余预算，耗尽后不再发命令。S1/S2与信号并非原子操作；此机制处理可观察的成员变化与已退出状态，稳定未知身份仍拒绝回收。

清理错误保留connection ID、固定内部错误码和阶段cause，以及单调时间上的EOF、wait250是否已观察到根exit、根exit时间/信号、成员数量变化、查询退出码、signal errno及record保留状态。命令全文、环境、owner token和外部Error原文不进入cause。`wait250Exited=true`表明该次核验前根已被Node回收，不能据此解释为根在随后S1→ps之间退出。MCP fixture在首次close失败时保存`first-cleanup-failure.json`；后续清理重试成功仍保留该目录中的首错证据。

真实进程回归用回环ACK和exit barrier固定以下顺序：S1后根退出而worker留存、S1后最后成员退出导致ps失败、核验后最后成员退出导致signal ESRCH；另检查稳定wrong-owner、身份查询权限失败、signal EPERM、TERM-resistant树再次验证后KILL，以及期限在ps或signal之前耗尽。断言同时覆盖实际信号、退出和record删除/保留。回归body采用45秒预算：文件5秒、start/ready各8秒、最多两轮close各5秒、首错写入5秒及检查余量9秒；关闭中的barrier共享close剩余期限。

普通MCP用例按握手/发现、请求、观察、显式close逐项设置正文预算。独立afterEach上限65秒覆盖控制发布/ACK7秒、请求/host close/首错写入26秒、HTTP child8秒、journal/worker退出13秒、文件5秒和余量6秒。受控树清理先通过独立控制端点退出，再由当前实例的真实owner执行有界兜底及退出观察；未知释放或首错均保留诊断目录。

该修复针对源码中可达的成员快照与退出竞态。历史e31组合CI的335ms失败只有外层清理码，不能从该日志确定具体内部失败分支；先前64983提交的完整CI通过与该组合失败分别记录。

已spawn但ownership写入未完成时，close先回收真实child和进程组，再用同一5秒总预算等待写入结算。未知写入返回明确失败并保留状态；写入稍后完成后可再次close移除记录。已确认回收的实例不会在重试时再次向历史PGID发信号。尚未spawn的初始化由closeRequested阻止晚启动。两个独立barrier回归分别覆盖spawn前等待和spawn后持久化等待，正文上限分别为38秒与60秒，包含独立释放、settlement、真实根退出兜底和文件清理。
