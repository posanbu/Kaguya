# Information DAG 终审修复报告

本轮从 `aa3b8c6` 开始，针对最终审查提出的一个 critical、六个 important/minor 与架构门禁建议完成修复。实现继续保持 `InformationCore.register()` 为运行期原子入口；Server、Gateway 与平台 adapter 均未取得数据库 repository、ModuleHost 或业务模块实例。

## 修复后的行为

NapCat 入站现在由 Server 根据 `KAGUYA_GATEWAY_ALLOWLIST_PLATFORMS`、`KAGUYA_GATEWAY_ALLOWLIST_USER_IDS` 和 `KAGUYA_GATEWAY_ALLOWLIST_GROUP_IDS` 构造 `GatewayAllowlist`，再把纯布尔谓词注入 NapCat adapter。OneBot frame 正规化并核验 self ID 后，必须先通过该谓词，才会调用 `InformationIngress.submit()`。拒绝路径不会调用 ingress，因此不会创建 context/inbound atom，也不会进入模型或投递链。Web gateway 不使用这个谓词；`GatewayAllowlist` 对 Web 消息也显式返回允许，Web 继续由 HTTP Bearer Token 边界控制。

`consumer.failed` 不再直接信任 `Error.name`。错误类型只有在长度不超过 128 且满足 ASCII 字母开头、其余仅字母或数字时才保留；否则固定为 `Error`。错误摘要仍为固定文本。回归测试把数据库 URL、密码同时放入 `name` 与 `message`，并确认账本事实中没有明文。

`InformationCore` 与 `ModuleHost` 现使用明确的 starting/closing 或 starting/stopping 状态和共享 promise。并发 start 不重复同步 kind 或创建模块实例；close/stop 与 start 交错时会等待启动工作并最终停在终态，不会重新变为 started。Core 关闭会先拒绝新注册，等待已接受的 register/broadcast 完成，再排空日志投影并清订阅。ModuleHost 停止会撤销新订阅入口，等待已进入 handler，再 dispose 实例。

ModuleHost 在创建每个实例前校验 `module:<instanceId>` 的 suffix：必须以小写字母开头，后续只能包含小写字母、数字、点、下划线或连字符。`Reply.One` 会在启动期被拒绝；同一次启动中已经创建的较早实例会被释放。

demo 的生产默认 ID 改为 `randomUUID`，测试通过 `RunDemoOptions.informationIdGenerator` 注入确定性序列，因此输出断言不变，同一持久账本连续执行两次也不会产生主键冲突。

日志投影 runner 会合并同进程并发批次，避免两个调用读取同一 pending job 并重复写 sink。新增 `drainPending()` 会持续读取成功批次直到 outbox 为空；如果一个批次发生失败则停止本轮 drain，把失败 job 留给后续调用或进程重启，避免关闭过程无限循环。Core.close 会在已接受工作结束后调用最终 drain。

Runtime 把 `database.migrate()` 的异常转换为不携带 cause 的 `RuntimeDatabaseInitializationError`。Server 将该类继续映射为 `InformationDatabaseConnectionError`；其余 Runtime 或模块启动异常映射为 `InformationRuntimeStartupError`。两种 Server 错误都只保留通过 grammar/长度检查的 `failureType`，不保存数据库 URL、凭据或原异常消息。

架构扫描新增独立 `emit` 规则并由 Vitest mutation-style fixture 验证。未加入“所有 production 信息写入只能出现 `core.register` 字面量”的规则：Runtime lifecycle、ModuleHost 与 Core 内部 ledger append 分属不同合法层级，基于调用文本的静态正则容易把端口实现和组合测试误判；现有门禁已经禁止旧 `emit`，而唯一写入口继续由类型边界与集成测试约束。

## TDD 证据

首次聚焦运行得到 14 个预期失败，分别命中 allowlist 未贯通、错误名泄漏、Core 三个生命周期/排空缺口、ModuleHost 三个生命周期/source 缺口、runner 两个并发/批次缺口、demo ID 冲突、Runtime/Server 错误分类和 `emit` 规则缺失。没有以 fixture 或导入错误作为 RED。

最小实现后，聚焦命令覆盖 Engine、Database、Runtime、Server/NapCat、demo 与架构脚本，共 9 个测试文件、95 项测试，全部通过。随后全仓运行 43 个测试文件、462 项测试，全部通过。

## 验证结果

- `pnpm lint`：通过。
- `pnpm typecheck`：通过。
- `pnpm test`：通过，43 files / 462 tests。
- `pnpm build`：通过，TypeScript project build 与 Web Vite production build 均成功。
- `pnpm --dir docs docs:check`：通过，VitePress 完成 client/server bundle 与页面渲染；仅有既有的大 chunk 警告。
- `pnpm exec tsx scripts/information-architecture.test.ts`：通过。
- `node scripts/workspace-smoke.mjs`：通过。
- `git diff --check`：通过。
- 本轮变更文件的 Prettier 检查：通过。

根级 `pnpm format:check` 仍返回非零：它报告 20 个早于本轮、且不在本轮 diff 的格式问题，包括历史 SDD 文档、既有 docs 配置、Web 测试与 Logger/Engine 文件。本轮没有为绕过验收而机械改写这些无关文件；计划内的所有新增或修改文件均已单独格式化并检查。

## 文档核对

公开 README 已明确说明平台白名单在提交 Runtime 前执行，环境变量参考只描述三个配置维度，均与最终实现一致，因此本轮没有改写公开文档。`docs/zh` 与 `docs/ours` 中仍可见迁移前的历史材料，但按 `docs/AGENTS.md` 它们由站点 `srcExclude` 排除，不作为当前公开契约；实际 VitePress 构建已通过。
