---
title: 信息模块 SDK 与 Core 宿主
description: 说明模块如何订阅 Information Kind 并注册因果派生原子。
---

# 信息模块 SDK 与 Core 宿主

模块不接触数据库连接，也不通过事件包装层传递业务结果。一个模块声明自己会消费或产生的 Kind，用 `onInformation` 订阅输入，并在 handler 中调用 `context.register()` 产生下一项不可变事实。

## 声明输入与输出

模块 manifest 的 `informationKinds` 必须包含它订阅和注册的每一个 Kind。Runtime 启动前将这些定义注册到 Core；ModuleHost 在启动时检查 manifest、订阅和 Registry 使用的是同一个 Kind definition，避免同名 Kind 被不同 schema 替换。

::: code-group

```ts [信息模块订阅 ~vscode-icons:file-type-typescript~]
onInformation(inboundTextKind, async (atom, context) => {
  await context.register(replyRequestedKind, {
    payload: { text: atom.payload.text, source: atom.payload.source },
  });
});
```

:::

`context.register()` 不接受调用方提供的 `informationId`、`source` 或发生时间。宿主会补齐 `source: module:<instanceId>`、当前时间、指向输入的 `core:caused-by`，以及输入已有的唯一 `core:context` 引用。调用方提供的额外 relation 必须不是这两个保留 relation，并且必须预先声明在目标 Kind definition 的 `references` 中；否则 Core 在提交时拒绝该原子。

## 广播、过滤与阶段关系

一个 Kind 可以有多个订阅者。Core 在原子持久化后对当前订阅者并发广播；注册先后与模块配置顺序不表达业务优先级。需要顺序时，前一阶段必须注册新的 Kind，后一阶段订阅该 Kind。

过滤也是普通的显式 DAG：通过时注册约定的下一 Kind，例如 `core.reply.requested`；拒绝时注册 `filter.decision`，并且不注册下一阶段。`filter.decision` 仅记录拒绝事实，不做定向路由。SDK 没有 targeted subscription、priority 或 interceptor API。

## 故障与生命周期

handler 抛出或 reject 时，Core 会记录一条 `consumer.failed`，其 `core:caused-by` 指向输入原子。该失败不会回滚输入，也不会阻止同一 Kind 的其他消费者；模块无需捕获错误再注册另一套失败事件。

Core 不会自动重试失败模块，也不为离线模块保存订阅或补投历史原子。模块应把可恢复策略建模为显式 Kind 与自身业务逻辑，而不是假定宿主提供队列语义。
