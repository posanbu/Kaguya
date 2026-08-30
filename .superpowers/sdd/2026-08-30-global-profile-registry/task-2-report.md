# Task 2 Report: Global Profile Registry manager/storage migration

本次 Task 2 的目标，是把 `packages/config` 中仍残留的 Task 1 之前语义彻底收口到新的 Global Profile Registry 契约上。核心变化不是单一方法改名，而是把初始化、默认 Profile、Profile 解析与磁盘持久化的边界同时改成“显式 bootstrap + selectedProfileId + 完整替换”的模型，并确保这一步不会破坏此前已经具备的敏感路径保护、原子写入和 mutation queue。

## 本次实现完成了什么

`packages/config/src/manager.ts` 已切换到新的公开接口。旧的 `initialize`、`getDefaultProfileId`、`setDefaultProfile`、可省略 ID 的 `resolveProfileById`，以及旧的 `updateProfile` 语义都已移除，替换为：

- `FileUserConfigManager.bootstrap`
- `getSelectedProfileId`
- `replaceProfile`
- `selectProfile`
- 必须显式传入 `ProfileId` 的 `resolveProfileById`

`bootstrap` 现在只接受两类目标根目录：缺失目录，或已存在但为空的目录。实现中会先写 `profiles/profile_default.json`，再发布 `index.json`，从而保证 index 永远是“最后发布”的提交边界。如果 index 写入失败，只删除这次 bootstrap 尝试创建的 `default` Profile 文件，不删除调用方原本拥有的根目录。

Registry 元数据已统一到 v3：

- `index.json` 使用 `version: 3`
- 顶层字段使用 `selectedProfileId`
- 首次 bootstrap 固定生成保留的 `default` Profile
- 首次 bootstrap 不自动创建 UUID Profile，也不要求初始化时直接给出完整可用配置

Profile 生命周期也已改成显式模式。`createProfile(name)` 现在只创建空 Profile，不会自动选中，也不会接收旧的初始 settings。完整配置必须通过 `replaceProfile(profileId, replacement)` 一次性替换写入。`selectProfile` 只更新 index，不重写 Profile 文件。删除时会同时保护：

- 保留的 `default`
- 当前 `selectedProfileId`

其中已选中 Profile 删除时返回新的 `CONFIG_PROFILE_IN_USE` 错误码。为了让包级类型检查恢复通过，我同步把这个错误码加入了 `packages/config/src/errors.ts`。

## 兼容性与安全边界

Task 1 review 中明确延后的 v2/default manager 引用，已在本次收口。`parsePersistedIndex` 现在会在任何目录准备或写入前拒绝 v1/v2 index，并统一抛出：

`CONFIG_UNSUPPORTED_VERSION`

错误消息也已改成 brief 指定的版本。`inspect`、`open` 与 `bootstrap` 针对 legacy index 的拒绝路径都覆盖到了测试里，并验证磁盘字节保持不变。

原有安全特性保持不变：

- `assertPathInside` 的根目录/子路径保护仍在
- `secure-files.ts` 的敏感目录权限和原子 JSON 写入仍被复用
- 所有写操作仍通过 manager 内部的 mutation queue 串行化
- create/replace/bootstrap/index-write failure 的回滚与失败后继续可用性仍有测试覆盖
- readiness 错误与校验错误仍避免泄漏敏感 secret

## 测试与验证

本次先按 brief 要求走了三轮 TDD：

- `pnpm vitest run packages/config/src/manager.test.ts -t "bootstrap"`
- `pnpm vitest run packages/config/src/manager.test.ts -t "profile lifecycle|profile resolution"`
- `pnpm vitest run packages/config/src/manager.test.ts -t "unsupported|rollback|index write"`

随后执行完整验证：

- `pnpm vitest run packages/config/src`
- `pnpm --dir packages/config typecheck`

截至 2026-08-30，这两项验证都已通过。`packages/config/src/manager.test.ts` 也已改写为新的 Task 2 契约，包含 bootstrap、selected profile、mandatory-ID 解析、legacy 拒绝、回滚与输入边界测试。

## 额外说明

brief 列出的变更文件是 `manager.ts`、`manager.test.ts`、`index.ts`。为了让新增的 `CONFIG_PROFILE_IN_USE` 通过类型系统并成为稳定公开错误码，我额外修改了 `packages/config/src/errors.ts`。这是一个受 Task 2 新契约直接驱动的最小必要改动，不属于额外扩张。
