# Task 1 报告：durable one-shot scheduler 公共契约

## 文件

- 新增 `packages/scheduler/src/contracts.ts`：请求、替换、完成、Core port、commit 类型和 v1 capability。
- 新增 `packages/scheduler/src/information-kinds.ts`：requested、due、fired、superseded、failed 五种 kind 及严格 payload/reference 规则。
- 新增 `packages/scheduler/src/client.ts`：`OneShotScheduleClient` 与 `normalizeDueAt`，只校验并转发 Core。
- 新增 `packages/scheduler/src/client.test.ts`：capability 导出和无时区 deadline 拒绝测试。
- 修改 `packages/scheduler/src/index.ts`：聚合新 API，移除旧 Trigger/timer/Cron 导出。
- 修改 `packages/scheduler/package.json`、`packages/scheduler/tsconfig.json`：接入 `@kaguya/sdk` workspace 依赖和 project reference。
- 删除 `packages/scheduler/src/index.test.ts`：旧 Manual/Interval/Cron API 测试随 API 删除。

## RED

命令：

```text
pnpm exec vitest run packages/scheduler/src/client.test.ts --maxWorkers=1
```

结果：失败（1 test failed）。失败原因为旧入口中 `oneShotScheduleCapability` 为 `undefined`，与预期 capability `{ id: "kaguya:schedule.one-shot", apiVersion: 1 }` 不匹配；Core mock 未被调用断言尚未执行。

## GREEN

命令：

```text
pnpm exec vitest run packages/scheduler/src/client.test.ts --maxWorkers=1
```

结果：通过，1 个测试文件、1 个测试通过。

```text
pnpm --filter @kaguya/scheduler typecheck
```

结果：通过，`tsc -b --pretty false` 返回 0。

## 第二轮 review 修复

SDK 的 kind-definition 静态检查不支持递归 `z.lazy`，但 durable requested payload 必须接受任意深度的 JSON object。为保持 SDK definition/reference 校验，同时让公开 payload schema 真正递归，本实现先用同形状的有限 placeholder 通过 `defineInformationKind` 的静态检查，再在冻结 definition 上替换为递归 JSON schema；运行时 schema 仍严格拒绝 Date、函数、undefined 等非 JSON 值。新增深层 object、array-of-object 和非 JSON 值测试。

修复后验证：

```text
pnpm exec vitest run packages/scheduler/src/client.test.ts --maxWorkers=1
```

1 个测试文件、4 个测试通过（含 valid schedule 的 offset normalization forwarding）。

```text
pnpm --filter @kaguya/scheduler typecheck
```

通过，返回码 0。

```text
rg -n 'ManualTrigger|IntervalTrigger|CronTrigger|interface Trigger' packages apps
```

结果：无匹配。

## 设计取舍与顾虑

- `OneShotScheduleClient` 不创建 timer、不访问存储；先解析完整输入，再规范化带时区的 `dueAt`，最后原样转发 Core 回执和错误。
- requested 使用 `core:caused-by`，replacement 可带单条 `core:replaces`；due 与 terminal kinds 使用单条 `core:status-of` 指向 requested。
- SDK 的 `defineInformationKind` 当前拒绝递归 lazy/transform payload schema，因此 requested 的 opaque input schema 使用可验证的严格 JSON 对象记录（字符串键及 JSON primitive 值）；client 入口仍使用 schema 的 JSON object 校验。
- 本任务未改动 Model Task、Runtime 或 apps 文件。

## Review 修复

- requested input schema 增加嵌套对象与数组的严格 JSON 分支，并新增 kind payload parse 测试。
- `normalizeDueAt` 现在要求完整 ISO 8601 date-time（`T` 分隔及 `Z`/数值 offset），新增非 ISO 日期拒绝测试。
- 新增 replacement、finish、capability forwarding 与 reference rule 断言。

修复后命令：

```text
pnpm exec vitest run packages/scheduler/src/client.test.ts --maxWorkers=1
```

结果：通过，1 个测试文件、3 个测试通过。

```text
pnpm --filter @kaguya/scheduler typecheck
```

结果：通过，`tsc -b --pretty false` 返回 0。
