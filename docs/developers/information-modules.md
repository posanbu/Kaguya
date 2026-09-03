---
title: 信息模块 SDK 与 Core 宿主
description: 说明信息原子模块如何声明输入 Kind、追加派生原子并交给 Core 广播。
---

# 信息模块 SDK 与 Core 宿主

Issue #40 的迁移以信息原子为边界。模块不再接触数据库连接，也不通过事件包装层传递业务结果；它们只声明自己消费的 Kind，并通过宿主提供的上下文追加新的信息原子。

## 模块声明输入与输出

`@kaguya/sdk` 提供 `defineInformationModule`、`onInformation` 和 `onTargetedInformation`。模块清单中的 `informationKinds` 必须列出模块可能订阅或追加的 Kind。Runtime 在启动 Core 之前注册这些 Kind，宿主启动时会检查清单与 Registry 中的定义对象是否一致，避免同名 Kind 被不同 schema 偷换。

```ts
const echo = defineInformationModule({
  manifest: {
    apiVersion: 1,
    definitionId: "example.echo",
    displayName: "Echo",
    settingsSchema: z.object({}).strict(),
    informationKinds: [inboundKind, outputKind],
  },
  create: () => ({
    subscriptions: [
      onInformation(inboundKind, async (atom, context) => {
        await context.append(outputKind, {
          payload: { text: atom.payload.text },
        });
      }),
    ],
  }),
});
```

`onTargetedInformation` 只把 payload 中 `targetInstanceId` 与当前模块实例匹配的原子交给处理器。同一 Kind 不允许同时存在广播订阅和目标订阅，以免同一输入在不同语义下被重复解释。

## 派生原子的因果关系

`context.append` 会由宿主补齐以下字段：

- `source` 固定为 `module:<instanceId>`；
- `occurredAt` 由宿主时钟生成；
- `core:caused-by` 指向当前输入原子；
- 输入原子已有的 `core:context` 引用会被继承。

模块可以追加业务关系，但不能覆盖或重复 `core:caused-by`、`core:context`。所有写入仍经过 `InformationCore.append`，因此 Kind schema、引用目标、数量限制和 append-only 约束由 Core 统一执行。

## 并发与故障边界

Core 广播会并发启动同一 Kind 的全部消费者，并以 `Promise.allSettled` 隔离单个消费者故障。一个消费者失败不会回滚已经提交的输入原子，也不会阻止其他消费者继续处理。宿主可注入 `InformationModuleRunLifecycle`，在处理前后记录 started、completed、failed 或 cancelled 生命周期事实；生命周期记录失败不会反向改变业务原子的提交结果。

当前仓库仍保留旧 EventBus/ModuleHost 以支持渐进迁移；Runtime 主链路切换到 InformationCore、内置 Kind 和原子化 delivery/LLM 生命周期属于后续阶段。换言之，本页描述的是已落地的模块 SDK 与宿主边界，不代表整个 Issue #40 已关闭。
