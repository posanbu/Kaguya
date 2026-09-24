---
title: 路由与导航调研
description: 核查 Kaguya 工作台的历史导航、深链接与离开保护，比较 React Router、TanStack Router 和原生 History API。
---

# 路由与导航调研

本文回答 [Issue #230](https://github.com/posanbu/Kaguya/issues/230)。核查日期为 2026-09-25，代码基线为 `2dad5c8330a6668e293f79995b2f477ce71ecc61`。结论用于后续方案讨论，不代表已选择路由库、确定 URL 结构或完成迁移。

## 当前问题是导航语义分散

`useWorkbenchRouter` 已实现异步离开确认：浏览器后退时先恢复当前位置，再确认是否提交导航，取消时保留 forward 历史。因此不能把现状概括为“没有 guard”。维护负担在于工作台自行管理历史索引、并发导航与 `popstate` 阶段，而页面匹配仍由 `App`、`DeveloperConsole` 和路由 helper 分别处理。[历史状态机](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/web/src/components/AppShell.tsx#L56-L160)

模块链接已经放行 Ctrl、Meta、Shift、Alt 与非主键点击，`SideNav` 却无条件 `preventDefault`，会拦截部分浏览器原生链接行为。Profile、模块配置和模板编辑还各自注册 `beforeunload`；迁移必须保留各编辑器的脏状态判断与保存失败后的草稿，而不能只换掉路径匹配。[模块链接](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/web/src/ModulePages.tsx#L45-L70)、[侧栏链接](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/web/src/components/AppShell.tsx#L171-L194)、[Profile 离开保护](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/web/src/use-profile-draft.tsx#L27-L49)

未知客户端路径最终显示聊天页；服务端则已有针对 HTML GET 的 SPA fallback，API 路径仍返回 API 404。应区分“能刷新一个深链接”与“页面正确识别不存在的路径”。模块和 Request 详情已有路径编码，但列表筛选、游标与选中记录并未统一进入 URL。当前壳层测试主要检查静态 HTML 与导航域，不能证明真实历史栈正确。[页面分派](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/web/src/App.tsx#L235-L306)、[服务端 fallback](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/server/src/app.ts#L1311-L1324)、[现有测试](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/web/src/components/AppShell.test.tsx)

## 候选能力与适用条件

**React Router** — Data Mode 的路由对象可以集中嵌套页面、动态参数、loader/action 与错误边界，适合先收拢工作台页面关系。`useBlocker` 提供阻塞、继续和取消状态，但只处理 SPA 内导航；刷新、关页和跨域跳转仍需浏览器离开保护。Loader 并不要求替代所有现有请求 hook，若同时引入 Server State 库，还需明确谁拥有缓存和刷新责任。[路由对象](https://reactrouter.com/start/data/routing)、[useBlocker](https://reactrouter.com/api/hooks/useBlocker)

**TanStack Router** — 类型化路径、参数与 `validateSearch` 更适合把检视页的筛选和详情状态变成可分享链接；支持代码式路由，不必先接受文件生成方案。`useBlocker` 的 `shouldBlockFn`、`withResolver` 与 `enableBeforeUnload` 能连接自定义确认界面，但其阻塞返回值不能直接照搬当前“允许导航”的 guard。类型推导、search 校验及路由树维护会增加初始迁移工作。[Search Params](https://tanstack.com/router/latest/docs/guide/search-params)、[Navigation Blocking](https://tanstack.com/router/latest/docs/guide/navigation-blocking)、[Not Found Errors](https://tanstack.com/router/latest/docs/guide/not-found-errors)

**原生 History API** — 保留当前方案可以避免库迁移，适合仅修复少量明确缺陷。它只提供历史项操作和事件，页面匹配、链接点击语义、查询参数校验、404、滚动恢复与异步确认仍由项目维护；当前状态机就是这部分长期成本。[History API](https://developer.mozilla.org/en-US/docs/Web/API/History_API)

兼容性核查应针对具体发布包。本次官方 registry 的 `react-router@8.4.0` 声明 React/React DOM `>=19.2.7`、Node `>=22.22.0`；`@tanstack/react-router@1.170.39` 声明支持 React 18/19、Node `>=20.19`，均为 MIT。Kaguya 锁文件中的 React/React DOM 是 `19.2.8`，根配置 Node 是 `24.18.0`，满足这些声明，但这不等于迁移已编译或浏览器行为已验证。后续应固定版本并复核升级记录，不能将官网 `latest` 的行为永久当作项目契约。[React Router 包元数据](https://registry.npmjs.org/react-router/8.4.0)、[TanStack Router 包元数据](https://registry.npmjs.org/@tanstack%2freact-router/1.170.39)、[锁文件](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/pnpm-lock.yaml#L133-L167)、[Node 配置](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/package.json#L5-L8)

## 条件建议与后续验证

若首要目标是减少手写历史状态机，优先用 React Router 做一个编辑页与详情页的小范围验证；若首要目标是类型化筛选深链接，则应同时比较 TanStack Router。只有在真实浏览器中证明收益和迁移成本后，才适合形成选型决定。本次不安装任何候选，也不规定 URL 中必须保存哪些筛选或游标。

验证应覆盖以下真实操作，不能用静态渲染替代：

- 编辑 Profile 后连续后退、取消、再前进；确认框出现期间再次导航；保存失败后取消离开。地址栏、页面、草稿和历史栈必须一致。
- 普通点击、Ctrl/Meta 点击、中键、复制链接和新标签页分别验证；新标签页是否具备认证应单独说明，不能把 Token 自动拼回链接来换取“深链接可用”。
- 直接打开并刷新模块详情、Request 详情和带筛选 URL；非法编码、过期游标、未知路径分别给出明确结果。客户端 404 与 API 404 不能混淆。
- 认证 fragment 的清理与历史恢复联动验证，见 [HTTP 与认证调研](./http-auth.md)。清理后刷新可能需要重新认证，这是认证决策，路由库不会自行解决。
