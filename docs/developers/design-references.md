---
title: 外部设计参考
description: Kaguya 持续感知、自然互动与记忆设计所参考的外部模型和项目。
---

# 外部设计参考

本页记录帮助 Kaguya 校准产品故事和设计问题的外部资料。它们提供的是可比较的思路，不是 Kaguya 的依赖、上游规范或现有能力证明；当前行为仍以代码、协议文档和[项目状态](../project/)为准。

阅读这些资料时，优先比较五个问题：什么变化会唤醒系统、一次理解覆盖哪些信息、输入和输出如何并行、系统何时选择行动或沉默，以及零碎证据如何沉淀为经历与认识。

## Thinking Machines Lab：Interaction Models

- [Interaction Models: A Scalable Approach to Human-AI Collaboration](https://thinkingmachines.ai/blog/interaction-models/)

TML 将输入和输出视作随时间连续推进的流，并以 time-aligned micro-turn 保留静默、重叠、打断和视觉线索。其 interaction model 维持实时互动，background model 异步承担较长推理与工具工作；委派时传递的是丰富上下文，而不是脱离情境的单条请求。

对 Kaguya 最重要的启发不是照搬 200ms 切片或双模型结构，而是：**turn 边界不应先于互动本身，行动时机也是语义的一部分。** 这支持我们把 Information 到达视为 tick、允许多个 tick 共同形成 observation，并把 `wait` 与 `silent` 作为正常结果。

边界：Kaguya 当前不是原生全双工多模态模型，也不把一个 InformationAtom 等同于固定时长的 micro-turn。TML 的模型结构、训练方法和推理部署不构成本项目协议约束。

## OpenAI：GPT-Live

- [Getting started with GPT-Live](https://developers.openai.com/api/docs/guides/live)

GPT-Live 将持续对话与后台任务分开：前台可以在监听和说话的同时决定何时委派，后台独立推理、使用工具并返回结果；用户在后台工作期间仍可补充信息，应用负责权限、确认、任务进度以及继续或取消的边界。

对 Kaguya 的参考点是：**互动存在感与深度工作可以按不同节奏推进，但必须共享可解释的上下文和生命周期。** 这与“输入/输出双轨”的实现哲学相符，也提醒我们在行动设计中明确规划期间的新 tick、结果回流和行动修订。

边界：Kaguya 不依赖 GPT-Live，也不把其 delegation、session 或供应商事件协议作为自身领域模型。当前 Heartbeat、Heartflow 和 Planner 的存在不表示已经具备语音全双工能力。

## MaiBot

- [MaiBot 仓库](https://github.com/Mai-with-u/MaiBot)
- [MaiBot 开发文档](https://docs.mai-mai.org/develop/)
- [Data & Memory API](https://docs.mai-mai.org/develop/webui-api/data-and-memory-api)

MaiBot 以群聊中的数字生命为主要故事，强调理解聊天气氛、在合适时机开口或闭嘴，并在长期互动中逐渐了解人物、语言和关系。它为 Kaguya 提供了贴近实际群聊的产品参照：自然互动不是逐条问答，记忆也不应只是一串彼此孤立的消息摘要。

对 Kaguya 的参考点是：**群聊中的零碎消息既是环境变化，也是形成共同经历的证据。** 这支持将 raw evidence 与派生认识分层，并要求 Memory、Knowledge 与 Expression 分别声明自己的真实语义输入范围。

边界：两者的模块划分、数据模型和发言策略可以不同。引用 MaiBot 是为了比较产品目标与设计问题，不代表复制其实现；涉及具体能力时，应分别核对双方当前代码和文档。

## 在设计讨论中如何引用

提出设计或 Issue 时，应写清楚“借鉴的问题”与“Kaguya 的边界”，不要只写“参考某项目”。至少回答：

1. 参考资料揭示了哪个互动或记忆问题？
2. 它依赖的输入单位、时间尺度和运行条件是什么？
3. Kaguya 当前已有哪部分基础，哪部分仍是待设计内容？
4. 哪些实现细节明确不进入本轮约束？

项目共同语言与强制检查项见[持续 Agent 设计原则](./continuous-agent)。
