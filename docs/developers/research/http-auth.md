---
title: HTTP Client 与认证调研
description: 核查五条前端请求路径、fragment Token 生命周期及响应校验，比较 Fetch、Axios、Ky、openapi-fetch 和 Zod。
---

# HTTP Client 与认证调研

本文回答 [Issue #234](https://github.com/posanbu/Kaguya/issues/234)。核查日期为 2026-09-25，代码基线为 `2dad5c8330a6668e293f79995b2f477ce71ecc61`。本次区分网络传输、身份生命周期和 DTO 校验，提供候选边界；不定义最终 transport 接口、错误分类或 Token 保存策略，也不新增依赖。

## 五条请求路径的实际差异

主客户端 `api.ts` 已封装空 Token 检查、Bearer 请求头与 401 事件；网络异常会转为 `GatewayRequestError`，Abort 也被归入 `network_error`，只在提示文字上区分。`readJson` 将 JSON 解析失败转成 `undefined`，后续调用者再验证响应；检视 DTO 使用共享 schema，其他响应仍存在手写 guard。[主客户端](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/web/src/api.ts#L640-L710)、[检视校验](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/web/src/api.ts#L1159-L1197)

四个独立入口仍直接调用 Fetch，且都在收到 HTTP 401 后派发同一个锁屏事件，但其余行为不一致：

- [module-settings-api.ts](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/web/src/module-settings-api.ts#L19-L54) 有空 Token 检查、可选 signal、共享 schema 与字段错误；字段数组只有粗粒度检查。
- [module-templates-api.ts](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/web/src/module-templates-api.ts#L23-L63) 有空 Token 检查、可选 signal 和共享 schema，但错误主要是普通 `Error` 与业务提示映射。
- [memory-ingestion-api.ts](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/web/src/memory-ingestion-api.ts#L33-L68) 有可选 signal、调用方传入 schema，并保留错误 code/status；有 body 时发 POST，没有自动重复写入。
- [identity-persona-api.ts](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/web/src/identity-persona-api.ts#L1-L52) 用局部 Zod schema，但未暴露 signal，也未在发请求前拒绝空 Token。

这四条路径均直接 `response.json()`，断网、Abort、空响应及代理返回 HTML 时会暴露不同异常形态。统一传输的价值是让调用者能稳定区分这些情形，同时保留 409 冲突、字段提示和草稿恢复等业务语义；更换库本身不能完成这一工作。

## Token 清理需要与导航及缓存一起讨论

`App` 仅在首次挂载时从严格格式的 `#gatewayToken=…` 读取 Token，保存在 React state；路由 `pushState` 又拼接当前 hash，代码没有完成使用后的 URL 清理。收到 401 后 App 锁屏，但该事件没有统一取消所有在途请求或清空未来查询缓存的职责。[初始化与锁屏](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/web/src/App.tsx#L162-L229)、[fragment 解析](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/web/src/App.tsx#L1698-L1711)、[导航保留 hash](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/web/src/components/AppShell.tsx#L80-L90)

Fragment 不会作为 HTTP 请求目标发送给服务器，但仍可出现在地址栏、复制链接及页面脚本读取结果中。读取后用 `replaceState` 清理当前地址是值得验证的方向，需保留 pathname、search 与已有 history state；它只能替换当前历史项，不能承诺清除先前复制或已经创建的全部历史记录。若继续仅内存持有，清理后刷新和新标签页将需要重新取得凭据。是否改变这一体验属于后续认证决策，不能在路由迁移中默默改成持久化存储。[URI fragment](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Fragment)、[replaceState](https://developer.mozilla.org/en-US/docs/Web/API/History/replaceState)

## 候选能力与边界

**Fetch** — 当前浏览器内建能力已满足同源 JSON 与 AbortSignal，无需额外运行时依赖；HTTP 4xx/5xx 不会自动 reject，认证、超时组合、JSON 失败和业务错误需统一封装。它是改动最小的基线候选。[Fetch 使用说明](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch)

**Axios** — 实例与 interceptor 适合集中附加认证和处理响应，支持 timeout 与 AbortSignal。新实现应使用 signal，避免已弃用的 CancelToken；interceptor 也不能代替 DTO schema，或让 401 自动变成安全的重登录、重放流程。[Interceptors](https://axios-http.com/docs/interceptors)、[取消请求](https://axios-http.com/docs/cancellation)

**Ky** — 基于 Fetch，提供 hooks、timeout、HTTP 错误和 JSON helper，适合希望减少传输样板且保留 Fetch 模型的项目。它带有 retry 机制，必须审查支持的方法、状态码及与查询库的叠加；尤其不能从“支持 retry”推导出 Memory POST 可以自动重发。[官方 README](https://github.com/sindresorhus/ky#readme)

**openapi-fetch** — 从 OpenAPI 生成的类型推导路径、参数和返回值，可降低接口拼写与类型漂移，但不自动校验实际返回 JSON。Kaguya 已有 Swagger 注册和 `/api/v1/openapi.json`，不能称为“尚无 OpenAPI”；部分路由 schema 仅有 tags/security，是否足以生成覆盖成功与错误响应的客户端仍需逐接口审计。生成契约覆盖不足时，换客户端不能补足契约。[客户端说明](https://openapi-ts.dev/openapi-fetch/)、[认证 middleware](https://openapi-ts.dev/openapi-fetch/middleware-auth)、[现有 Swagger 与配置路由](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/server/src/app.ts#L692-L749)

**Zod** — 负责运行时解析和校验，能与上述任一 transport 配合，不能承担网络取消、认证或重试。项目共享 schema 已固定 Zod `4.4.3`；迁移时宜先明确共享 DTO 与局部 schema 的边界，避免把 TypeScript 泛型当作远端数据验证。[Zod 官方说明](https://zod.dev/)、[项目版本](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/packages/schema/package.json#L15-L17)

核验的发布包 Axios `1.20.0`、Ky `2.1.0`、openapi-fetch `0.17.0` 与 Zod `4.6.5` 均为 MIT，均不要求 React peer。Ky 声明 Node `>=22`，项目 Node `24.18.0` 满足此门槛；其他包未声明 Node engines 不等于保证所有运行时兼容。上述是调研用元数据，项目未升级 Zod、未安装候选，也未测量新增 bundle。维护成本分别落在 interceptor 约定、Fetch/hooks 默认值、生成契约同步和 schema 升级上。[Axios](https://registry.npmjs.org/axios/1.20.0)、[Ky](https://registry.npmjs.org/ky/2.1.0)、[openapi-fetch](https://registry.npmjs.org/openapi-fetch/0.17.0)、[Zod](https://registry.npmjs.org/zod/4.6.5)

## 条件建议与后续验证

建议先以原生 Fetch 的统一行为为基线，验证是否已能消除五条路径的差异；确有重复 hooks、timeout 或拦截需求时，再比较 Ky 与 Axios。只有 OpenAPI 覆盖达到生成要求后，才值得评估 openapi-fetch。无论选择哪种，Zod 或等价运行时校验仍是独立责任。

实施前的验证场景应包括：空 Token 不发请求；401 响应即使是 HTML 也能锁屏，旧请求晚到后不恢复敏感页面；Abort 不显示成普通断网；204、非 JSON、错误 envelope、成功状态但 DTO 不合约分别处理；409 保留草稿和字段提示；Memory 写入超时不自动重复。还应在新标签、刷新、后退和复制链接中检查 fragment 清理，并与 [Server State](./server-state.md) 验证认证变化后的缓存隔离。以上是验收场景，不是本次已完成的生产行为。
