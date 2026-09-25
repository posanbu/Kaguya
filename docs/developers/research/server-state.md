---
title: Server State 调研
description: 比较 TanStack Query、SWR、RTK Query 与现有 hook，明确缓存隔离、取消、分页和重试的验证边界。
---

# Server State 调研

本文回答 [Issue #231](https://github.com/posanbu/Kaguya/issues/231)。核查日期为 2026-09-25，代码基线为 `2dad5c8330a6668e293f79995b2f477ce71ecc61`。Server State 指服务器数据在浏览器中的副本及其加载生命周期；编辑草稿、弹窗开关与数据库持久化不属于同一层。本次比较候选，不制定 query key、缓存时长或最终重试策略。

## 已有隔离机制，但生命周期尚未统一

`useInspection` 已在卸载或参数变化时 abort，并以路径、刷新 revision 和 Token 区分当前结果，避免显示上一请求的数据。它没有共享缓存或请求去重；内部 key 包含原始 Token，未来不能直接复制到可被 Devtools、日志或持久化插件观察的公共 cache key。[useInspection](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/web/src/use-inspection.ts#L8-L36)

差异主要出现在其他读取路径。Overview 用 `live` 标志丢弃过期结果，创建的 AbortController 未在清理时取消；ProfileWorkspace 每 5 秒刷新，以 sequence 避免乱序覆盖，但不取消网络请求，也不检查页面隐藏。AdapterStatus 已具有页面隐藏暂停、abort 和避免轮询重叠的实现，不能笼统称为“所有轮询都缺取消”。[Overview](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/web/src/Overview.tsx#L23-L48)、[ProfileWorkspace](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/web/src/ProfileWorkspace.tsx#L100-L121)、[AdapterStatus](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/web/src/adapter-status.ts#L27)

Record、Module、Request 和 Storage Surface 各自保存 cursor stack、刷新版本及详情选择。引入缓存库可以统一副本生命周期，但不会自动决定筛选改变后如何回到第一页、失效游标如何恢复或列表与详情如何同步。`cache: "no-store"` 约束的是 Fetch 使用的 HTTP 缓存，不能当作 JavaScript 查询缓存已被禁止或清空的证据。[RecordSurface](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/web/src/RecordSurface.tsx#L63-L111)、[getInspection](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/web/src/api.ts#L1159-L1197)

## 候选能力与维护成本

**TanStack Query** — 提供查询共享、失效、预取、分页和轮询，适合多个 Surface 复用 list/detail 数据的工作台。默认缓存立即 stale、失败查询会重试，重新聚焦可能触发后台读取；这些默认值必须逐类审查。Query 提供 AbortSignal，但请求函数须把 signal 传入实际 transport；“组件卸载”本身不保证底层请求取消。分页的 `placeholderData` 可以保持上一页，也可能在身份切换时错误展示旧数据，不能全局照搬。[默认行为](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults)、[取消机制](https://tanstack.com/query/latest/docs/framework/react/guides/query-cancellation)、[分页](https://tanstack.com/query/latest/docs/framework/react/guides/paginated-queries)

**SWR** — `useSWR`、`mutate` 和 `useSWRInfinite` 可以覆盖读取、重新校验及游标分页，适合读多写少且希望较少 API 概念的页面。默认共享缓存，定制 provider 后需要使用对应作用域的操作；底层网络取消仍须专门接入。已核对 `swr@2.5.1` 发布包导出 `unload`；其实现清空缓存并使在途结果失效，不中止底层网络，因此不能替代 AbortSignal。[该发布包对应源码](https://github.com/vercel/swr/blob/7173e55b2a175dee455612c5fa067383345c392f/src/_internal/utils/cache.ts#L80-L130)错误重试也需要按状态与业务操作限制。[官方缓存文档源码](https://github.com/vercel/swr-site/blob/main/content/docs/advanced/cache.mdx)、[分页文档源码](https://github.com/vercel/swr-site/blob/main/content/docs/pagination.mdx)、[错误处理文档源码](https://github.com/vercel/swr-site/blob/main/content/docs/error-handling.mdx)

**RTK Query** — `createApi`、自动生成 hook 与 tag invalidation 适合已有 Redux store 的应用。Kaguya Web 当前未直接依赖 Redux；采用它需要增加 store、reducer、middleware 与团队约定，不能只按请求 hook 数量比较成本。`fetchBaseQuery` 提供 Fetch 封装，`retry` 是可选包装器，不应把示例中的多次重试当成所有 RTK Query 请求默认行为。[概览](https://redux-toolkit.js.org/rtk-query/overview)、[自定义请求与重试](https://redux-toolkit.js.org/rtk-query/usage/customizing-queries)、[当前依赖](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/web/package.json)

**延续自研 hook** — 现有 `useInspection` 行为简单、边界可读；若只补取消和统一轮询，可保留它。若继续加入共享缓存、去重、失效、预取及分页恢复，项目就需要维护相当于查询库的生命周期规则。应以实际页面需求判断这个成本，而不是以“零新增依赖”代替维护评估。

本次核验的 `@tanstack/react-query@5.103.2`、`swr@2.5.1`、`@reduxjs/toolkit@2.12.0` 均声明 MIT，React peer 范围包含当前项目的 React 19；RTK 的 React hook 路径还涉及 React Redux。发布版本与维护主分支必须分开：SWR 主分支当时为 beta，本文兼容性依据官方 registry 的发布包。声明兼容尚未经过 Kaguya 安装或构建验证。[Query 元数据](https://registry.npmjs.org/@tanstack%2freact-query/5.103.2)、[SWR 元数据](https://registry.npmjs.org/swr/2.5.1)、[RTK 元数据](https://registry.npmjs.org/@reduxjs%2ftoolkit/2.12.0)

## 条件建议与后续验证

若希望跨检视页共享缓存并统一分页、刷新与取消，TanStack Query 值得优先做局部验证；SWR 作为读取为主的对照，RTK Query 则等待独立的 Redux 需求成立。正式选择前需要验证：

- Token 失效或未来支持身份切换时，停止旧请求、移除旧副本，并拒绝晚到结果。可以比较“认证会话代次”或独立缓存作用域，不能把原始 Token 暴露到 key；当前 App 的 Token 只在挂载时读取，尚无原地换 Token 流程。
- 改变模块、路径或筛选后，不使用旧 cursor 或旧详情；返回上一页、刷新后服务端数据改变、游标失效时，页面与选择状态仍一致。是否保存游标到 URL 交由路由讨论。
- 401、403、DTO 校验失败、主动取消、瞬时断网分别验证；不能让默认 retry 重放 Memory 录入 POST、配置应用或其他写操作。若 transport 也重试，应避免两层重试相乘。
- 后台标签页停止适当轮询，恢复可见时按明确规则刷新；两个组件同时读取同一资源时去重，卸载一个组件不误伤仍在使用该资源的组件。缓存库不替代 [HTTP 层](./http-auth.md)的认证与运行时校验。
