## 选用 Vercel AI SDK Core 的理由

### 1. 统一的 provider 抽象层

packages/llm 需要对上层暴露一个统一客户端接口，在内部适配具体 provider，业务工作流不能直接导入供应商 SDK（architecture.md:209、design spec 第 209 行）。Vercel AI SDK Core 的核心价值正是把 OpenAI / Anthropic / Google 等不同 provider 归一化到同一套 LanguageModel 接口，天然满足「换 provider 不改业务代码」这个边界要求。

### 2. 内置可测试的 mock model（关键决定因素）

项目有一条硬性约束：测试、demo、Promptfoo 回归都必须不依赖远端模型、不读 API key、不访问网络（README.md:14、README.md:53）。

Vercel AI SDK 提供 ai/test 的 mock model 和 MockLanguageModelV3，demo 直接注入它并按调用顺序返回确定性 JSON（architecture.md:252、design spec 第 29 行）。
这让整套确定性测试无需自己造一层 provider 抽象，SDK 原生支持。

### 3. 结构化输出 + trace 友好

LLM 边界需要做结构校验并记录完整调用 trace（请求类别、模型标识、归一化消息、usage、耗时、错误分类等，architecture.md:211-250）。AI SDK Core 的 generateObject/结构化生成能力和标准化的 usage/响应结构，正好对接这套 trace 归一化需求（retryable/non-retryable/cancelled）。

### 4. 只用 Core，不用框架层

文档特意写的是「Vercel AI SDK Core」，而非整套 AI SDK。这符合项目「基础设施原型、不引入重依赖」的一贯取向（如数据库层也刻意不引 ORM，只用 node:sqlite）。Core 只提供 LLM 调用原语，UI/React 相关部分不引入。

## 不同 SDK 的影响维度

在 Kaguya 里：

单事件流：一条顶层事件带一个 traceId，经模块节点 fan-out，但共享 trace 血缘（architecture.md:200）。一次完整处理可以包含 route、reply、state 和 memory 四类模型调用。
多模型：四类 kind 每个都带自己的 modelId（architecture.md，generate 请求必须携带 kind + modelId）。现实中 route 用便宜小模型、reply 用大模型、state/memory 用中等模型是很自然的装配——甚至可能跨 provider（route 用 Gemini Flash、reply 用 Claude）。
所以真正的问题是：当同一条 trace 里要顺序/并发调用多个异构模型时，SDK 的抽象层会在哪些地方帮你、或坑你。 下面按影响维度拆。

### 1. 接口归一化 —— 这是"多模型"最核心的分野

Kaguya 要求"业务工作流不能直接导入供应商 SDK"（architecture.md:209）。用官方 SDK 意味着你必须自己在 @kaguya/llm 里写一层归一化——本质是重造 AI SDK Core 的一小块。多模型越多，这层自造代码的分叉成本越高。AI SDK Core 直接把这层送给你。

### 2. usage / trace 字段的归一化 —— 单事件流下最容易被低估

系统每次调用都写 trace，且要求 "归一化 usage、起止时间、耗时"（architecture.md:247）。

不同 provider 官方 SDK 的 usage 字段命名和结构都不同（prompt_tokens vs inputTokens，是否含 cache/reasoning token…）。单事件流里同一条 traceId 下混着多个 provider 的原始 usage，你必须自己对齐口径，否则 trace 里的 token/耗时无法横向汇总。
AI SDK Core 已经把 usage 归一到统一结构，四类模型即使跨 provider，写进 llm_traces 的字段口径也是一致的——这直接服务于"单事件流"要能聚合统计的目标。
这是"单事件流 + 多模型"组合专属的痛点:单模型时字段不一致无所谓,多模型 + 要聚合 trace 时,归一化就是刚需。

### 3. 错误归一化 → 决定重试语义

系统把错误归一为 retryable / non-retryable / cancelled（architecture.md:248）。

多个 provider 的错误类型、超时/取消信号、限流码各不相同。用官方 SDK,你要为每个 provider 分别映射到这三态。
AI SDK Core 提供统一的 error 类型和 abort 语义,一套映射覆盖所有模型。单事件流里 route 失败要不要连累整条 trace、能否 cancel 下游,这套判断在统一 error 模型下才写得干净。

### 4. 结构化输出 —— 四类 schema 的落点

四类 kind 都要求严格 JSON 结构（architecture.md 的 kind 表）。

AI SDK Core 的 generateObject + schema 在所有 provider 上行为一致(内部处理 JSON mode / tool-call / grammar 的差异)。多模型下你写一次 schema 校验,不用关心底下是 OpenAI 的 json_schema 还是 Anthropic 的 tool。
官方 SDK:各家结构化输出机制不同,多模型 = 多套结构化调用代码路径。5. 测试可确定性 —— 多模型时的组合爆炸
demo 按调用顺序注入 MockLanguageModelV3 返回确定性 JSON（architecture.md:252）。

单事件流串起四个模型调用,测试需要一个 mock 层能按序模拟这 4 个异构模型。AI SDK 的 mock model 是统一接口,一个 mock 覆盖全部四类,与真实 provider 无关。
若用官方 SDK,你要么 mock 四个不同 SDK 的 client,要么先自建抽象再 mock——测试复杂度随模型种类线性上升。

### 6. 反向代价（选 AI SDK Core 要接受的）

公平地说,统一抽象也有成本:

能力最小公分母 / provider 专属特性:某个 provider 的独有参数(如 Anthropic 的 prompt caching、cache breakpoint、某些 reasoning 控制)在统一接口里可能暴露得晚或需要走 providerOptions 逃生口。多模型系统若想精调某一个模型的独家能力,统一抽象会挡一层。
版本追随:新 provider 特性要等 SDK 适配。官方 SDK 永远最快拿到自家新功能。
抽象泄漏:极端情况下你仍需针对某模型写 provider-specific 分支,这时统一层反而多绕一圈。
结论(针对 Kaguya 这个系统)
在"单事件流 + 多模型"下,SDK 的影响集中在四个归一化点:接口、usage/trace、错误语义、结构化输出——而这四点恰好都是 Kaguya 的硬性设计约束。

用 AI SDK Core:多模型的差异被吸收在 @kaguya/llm 边界之内,单事件流的 trace 聚合、错误分类、确定性测试都"一次编写、全模型适用"。代价是牺牲少量 provider 独家能力的即时可达性。
用 官方 SDK:你会在 @kaguya/llm 里手工重建上述归一化层,模型/provider 越多,这层越重、越易分叉;换来的是对每个模型独家能力的完全掌控。
用 LangChain:也能统一,但它带来 chain/runnable/memory 等一整套自有概念,与 Kaguya 已经自建的事件总线、Prompt 编译、trace 体系职责重叠,反而增加认知与耦合成本——对一个刻意"不引 ORM、只用 Core"的极简原型不划算。
对 Kaguya 这种多模型异构但要求单一 trace 血缘可聚合的系统,AI SDK Core 的取舍是合理的:它把"多模型"的复杂度压在一个统一边界里,让"单事件流"的可观测性得以成立。
