---
title: Durable One-Shot 调度
description: 绝对时间、可恢复且以唯一终态收敛的一次性调度协议。
---

# Durable One-Shot 调度

Kaguya 的 one-shot 调度表示一个带绝对截止时间的持久化意图。调度请求写入 `core.schedule.one-shot.requested`，数据库中的 arm projection 只保存 `dueAt` 与当前执行状态；进程内 timer 随时可以从 projection 重建。timer 不是业务事实，也不保存 callback、闭包或 Node timer handle。

## 模块 API

模块通过 `kaguya:schedule.one-shot@1` 使用三个操作：

```ts
const receipt = await schedule.schedule({
  operationKey: "wait:input-123",
  sourceInformationId: input.informationId,
  dueAt: "2026-09-06T12:05:00+08:00",
  input: { inputInformationId: input.informationId },
  activation,
});

await schedule.replace({
  ...request,
  operationKey: "wait:input-124",
  previousScheduleInformationId: receipt.scheduleInformationId,
});

await schedule.finish({
  scheduleInformationId: receipt.scheduleInformationId,
  status: "fired",
});
```

`dueAt` 必须包含时区，写入前会规范化为 UTC。`input` 是模块拥有的 JSON 对象，scheduler 不解释其字段。`operationKey` 负责幂等；`informationId` 是这次工作的唯一身份。

## 状态与投递

一次调度依次可能产生 requested、due 和一个 terminal。terminal 可以是 fired、superseded 或 failed，三者共享同一个唯一终态槽。due 由可靠 DAG 至少投递一次，因此 consumer 必须调用 `finish()` 并接受已经存在的赢家；重复 due 不会产生第二个 terminal。

replacement 在同一数据库事务中创建新 requested、创建新 arm，并尝试为旧 schedule 写入 superseded。若旧 schedule 已经有 terminal，新 schedule 仍然独立创建，旧 terminal 不会被覆盖。fired 与 replacement 并发时，数据库锁和 terminal 槽保证旧 schedule 只有一个赢家。

## 启动与关闭

Runtime 先迁移数据库、启动 Core 和可靠模块订阅，再恢复所有 open arm。恢复完成以前 ingress 保持关闭。future arm 重新设置本地 timer，overdue arm 立即发出幂等 due。长延迟会分段等待，避免超过 Node timeout 上限。

关闭时先停止 scheduler、清理 timer 并有界排空正在发送的 due，再停止 ModuleHost、Core 和 Runtime 自己创建的数据库连接。正常关闭不会把 open schedule 改成 cancelled 或 failed；下一次启动会继续恢复它。

## 边界和非目标

由于可靠消费和外部副作用都是 at-least-once，模块必须把业务结果写入唯一终态槽；外部 API 的重复调用仍需由外部幂等键处理。首版只保证单 Runtime，暂不提供多 Runtime lease、人工取消、人工重跑、Cron、时区规则、DST 或复杂 jitter。固定间隔 cadence 是独立协议，参见 [Durable Cadence](../guide/cadence)；#81 继续负责更高层的日历与运维策略。
