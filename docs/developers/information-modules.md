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

## 显式选择运行上下文

需要为 Prompt 或其他派生计算加载上下文时，模块先用 `defineInformationSelector()` 声明选择规则，再在 handler 中调用 `context.select()`。Selector 接触的是受限只读账本，只能返回有序的 `informationId` 列表；Core 会校验列表、按该顺序重新加载原子，并把冻结后的原子返回给模块。模块不能把查询结果中的 payload 直接拼成未落账上下文。

::: code-group

```ts [按引用选择当前输入与 Memory ~vscode-icons:file-type-typescript~]
const replyContextSelector = defineInformationSelector({
  selectorId: "reply.with-referenced-memory",
  async select({ sourceAtom, ledger }) {
    const memories = await ledger.related({
      from: [sourceAtom.informationId],
      relation: "core:uses-context",
      direction: "incoming",
      limit: 8,
    });

    return [
      sourceAtom.informationId,
      ...memories.map((memory) => memory.informationId),
    ];
  },
});

onInformation(replyRequestedKind, async (atom, context) => {
  const contextAtoms = await context.select(replyContextSelector);
  // 这里只渲染 Core 已校验并重新加载的账本原子。
});
```

:::

只读账本提供三种受控入口：`find()` 按 kind、来源和发生时间筛选；`related()` 沿引用图单跳读取；`retrieve()` 调用 Core 配置的命名检索策略。每次查询都必须给出 `limit`，`find()` 还必须至少给出一个筛选条件。读取器返回的候选只在本次选择调用中授权，并发调用之间不共享授权状态。

Selector 的最终结果不能包含重复 ID，也不能包含当前输入或本次读取器从未授权的 ID。未知、重复、越权，以及选择后重新加载时消失的原子都会由 Core 明确报错；模块不应捕获这些错误后自行回退到历史数据。

内置 reply 默认 Selector 只返回当前已接受的 `core.reply.requested` 原子，不按用户、群组、时间窗口、`core:context` 或其他字段自动聚合历史。需要更多上下文时，必须用新的 Selector 显式查询并返回相应 ID。

## Prompt 与 Memory 的可追溯性

reply Prompt 只渲染当前输入和 Selector 选中的、已有明确 renderer 的账本原子。每个 Prompt fragment 都携带来源 `informationId`；LLM requested 原子再以相同顺序写入 `core:uses-context` 引用，因此可以从请求追溯到实际输入原子。未知 Kind 不会被当作文本静默注入 Prompt。

Memory 是普通的 `core.memory.text` information kind，payload 只保存文本。产生 Memory 的模块应通过一个或多个有序 `core:uses-context` 引用指向其输入原子；Memory 只有被 Selector 明确选中时才进入 Prompt。Memory、Prompt 和 reply 路径不使用 `sessionId` 或 `contextKey`，也不存在以隐式会话桶恢复历史的旁路。

## 广播、过滤与阶段关系

一个 Kind 可以有多个订阅者。Core 在原子持久化后对当前订阅者并发广播；注册先后与模块配置顺序不表达业务优先级。需要顺序时，前一阶段必须注册新的 Kind，后一阶段订阅该 Kind。

过滤也是普通的显式 DAG：通过时注册约定的下一 Kind，例如 `core.reply.requested`；拒绝时注册 `filter.decision`，并且不注册下一阶段。`filter.decision` 仅记录拒绝事实，不做定向路由。SDK 没有 targeted subscription、priority 或 interceptor API。

## 故障与生命周期

handler 抛出或 reject 时，Core 会记录一条 `consumer.failed`，其 `core:caused-by` 指向输入原子。该失败不会回滚输入，也不会阻止同一 Kind 的其他消费者；模块无需捕获错误再注册另一套失败事件。

Core 不会自动重试失败模块，也不为离线模块保存订阅或补投历史原子。模块应把可恢复策略建模为显式 Kind 与自身业务逻辑，而不是假定宿主提供队列语义。
