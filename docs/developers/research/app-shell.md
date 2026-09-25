---
title: 应用壳层与后台框架调研
description: 比较后台框架与分层组合对 Gateway 认证、领域 Surface 和现有 SPA 宿主的适配成本。
---

# 应用壳层与后台框架调研

本文对应 [#237](https://github.com/posanbu/Kaguya/issues/237)。核验日期为 2026-09-25，代码基线为 [`2dad5c83`](https://github.com/posanbu/Kaguya/tree/2dad5c8330a6668e293f79995b2f477ce71ecc61)。研究范围是职责覆盖与迁移代价，建议仍待决策；不在此规定 Provider 顺序、模块注册、拆包方案或框架接管范围，也未运行候选接入原型。

## Kaguya 已有壳层，但领域流程仍由项目装配

[AppShell](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/web/src/components/AppShell.tsx) 已提供共享侧栏、移动抽屉、导航上下文与 History 守卫；取消后退使用历史位置恢复，不能将现状说成没有路由。缺少的是第三方 Router 和统一 Server State 层，证据见 [Web 依赖](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/web/package.json)。[App](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/web/src/App.tsx#L162) 仍管理鉴权、配置状态和多个页面的装配，并直接导入主要页面。

用户既需要聊天、保存配置并显式应用，也需要理解 Attention Gate 和模型请求的因果链。后台框架可减少通用列表/表单代码，但不能以 CRUD 成功替代“配置已生效”或“回复已送达”。当前 Gateway Token 从 URL fragment 读取到页面状态；框架示例中的账户登录和持久化 token 策略不能直接照搬。主 JS 的当前测量与警告见[总览](./index)，尚无候选拆包收益数据。

## 各候选能接管什么

**React Admin。** `Admin` 组合资源、Data/Auth Provider、路由、查询与布局，适合有大量常规资源管理页的系统。它并非只能做 CRUD：`CustomRoutes` 可以承载领域页面，Data Provider 可以映射自定义请求，`pageInfo` 还支持不返回总数的部分分页。然而 Kaguya 的 cursor、脱敏 DTO、Trace 与保存/应用两阶段行为仍需适配；默认 Material UI 组件与现有 Radix/CSS 也有重叠。没有总数不是硬性淘汰理由，适配后是否仍节省维护才是问题。[Admin](https://marmelab.com/react-admin/Admin.html)、[Data Provider](https://marmelab.com/react-admin/DataProviderWriting.html)、[自定义路由](https://marmelab.com/react-admin/CustomRoutes.html)。开源核心为 [MIT](https://github.com/marmelab/react-admin/blob/master/LICENSE.md)，[Enterprise 私有模块与支持](https://react-admin-ee.marmelab.com/) 为商业服务，不能合并算作免费能力。

**Refine Core。** Headless 方式提供资源、数据、认证、路由集成与查询 hooks，可保留自有 UI。`dataProvider.custom`/`useCustom` 可接非标准端点，因此 Gateway 和领域 Trace 并非技术上无法适配；Auth Provider 也可承接现有认证结果。成本在于将现有错误、取消、缓存隔离和导航守卫接入其约定。若多数页面最后都依赖自定义调用与专用组件，资源抽象可能只增加一层装配。[官方概览](https://refine.dev/core/docs/)、[Data Provider](https://refine.dev/core/docs/data/data-provider/)、[Auth Provider](https://refine.dev/core/docs/authentication/auth-provider/)。开源 Core 为 [MIT](https://github.com/refinedev/refine/blob/main/LICENSE)，免费使用 Core 不意味着其同品牌服务都免费。

**React Router + TanStack Query + TanStack Table。** 分别处理导航、服务端状态和列表状态，能保留现有壳层与领域 Surface，并逐层评价收益。Router 有不同使用模式，不能默认引入其完整框架模式；Query 的缓存/刷新和 Table 的分页也仍需遵守 Gateway 与服务端契约。优势是迁移边界可以较小，代价是组合一致性、错误显示和操作后反馈仍由项目负责。[Router 模式](https://reactrouter.com/start/modes)、[Query 职责](https://tanstack.com/query/latest/docs/framework/react/overview)、[Table 职责](https://tanstack.com/table/v8/docs/overview)。三者核心分别为 [MIT](https://github.com/remix-run/react-router/blob/main/LICENSE.md)、[MIT](https://github.com/TanStack/query/blob/main/LICENSE)、[MIT](https://github.com/TanStack/table/blob/main/LICENSE)，无核心库商用许可费。

**React + Vite + Radix 自有壳层。** 延续当前部署形态和产品行为，适合维护范围有限且页面变化可控的阶段。React 提供组件模型、Vite 提供开发与构建、Radix 提供交互 primitives；它们不会自动消除根组件的职责集中。现有 [React](https://github.com/facebook/react/blob/main/LICENSE)、[Vite](https://github.com/vitejs/vite/blob/main/LICENSE)、[Radix](https://github.com/radix-ui/primitives/blob/main/LICENSE) 为 MIT，可免费商业使用；选择延续仍需承担状态装配与回归验证成本。[Vite 文档](https://vite.dev/guide/)、[Radix 职责](https://www.radix-ui.com/primitives/docs/overview/introduction)。

**TanStack Start。** 基于 Router 的全栈能力包含 SSR、流式渲染、Server Functions 与服务端路由。若后续确需全栈页面渲染或统一服务端入口，值得独立评价；只为整理当前 SPA 壳层而引入，需解释新增构建、宿主与鉴权边界的收益。它不是使用 TanStack Router 的必要前提。核心为 MIT；部署平台服务成本另计。[官方能力](https://tanstack.com/start/latest/docs/framework/react/overview)、[许可证](https://github.com/TanStack/router/blob/main/LICENSE)。

## 条件建议与后续验证

若领域解释页仍占主要工作量，优先比较自有壳层与分层组合；若常规资源管理明显增加，再比较 React Admin 或 Refine 能消除多少重复工作。全栈需求尚未确定时，Start 应保留为不同架构范围的候选。这些是依据当前代码的研究判断，不是正式选型。

任何接入都应复用同一组场景评价：深链接进入请求详情；Profile 有未保存输入时前进/后退并取消；保存后尚未应用；并行请求遇到 401；页面切换后旧响应返回；窄屏抽屉焦点恢复。还需证明 token 不被框架示例的持久化策略带入长期存储，领域 DTO 未被通用资源模型丢失，且当前 React/Vite 版本与候选 peer dependency 匹配。应记录真实浏览器结果、适配代码量和生产构建差值，不能用功能清单代替兼容性或迁移收益证明。
