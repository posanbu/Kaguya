---
title: Web 检视基础设施调研
description: 八类基础设施的现状证据、候选边界与后续决策入口。
---

# Web 检视基础设施调研

本组资料对应 [#229](https://github.com/posanbu/Kaguya/issues/229) 及其八个 research 子项。调研回答各层目前缺少什么、候选工具实际提供什么，以及哪些条件需要在接入前验证。**调研结论不等于正式选型或已完成迁移**；这些页面没有为项目新增 Router、Query Client、数据网格、数据库管理界面或浏览器测试框架。

核验日期为 2026-09-25，代码基线为 [`2dad5c83`](https://github.com/posanbu/Kaguya/tree/2dad5c8330a6668e293f79995b2f477ce71ecc61)。各专题给出固定提交的源码入口和一手资料；候选的功能、许可证与商业功能边界以所链接的上游资料为准，进入实施时需要重新确认拟锁定版本。

## 先确认用户要完成什么

普通使用者需要理解模块保存了什么、某次处理为何发生，以及如何沿来源追溯；维护者还需要检查数据库行、索引与查询。两者共享部分事实，但权限、操作后果和解释方式不同。检视基础设施应围绕“找到对象、理解状态、查看证据、返回原位置”评价，不能仅因工具提供表格或 CRUD 页面，就认为它覆盖了模块检视任务。

典型场景是：从模块记录列表定位一条记录，打开请求或原始证据，返回后仍保留筛选、选中位置与合理焦点；在窄屏、网络失败、鉴权失效和数据持续增加时，这条路径也应有明确结果。这些是后续验证场景，当前调研没有把它们全部标成已通过的产品行为。

## 当前基线与已纠正的描述

[`apps/web/package.json`](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/web/package.json) 使用 React、Vite、Radix 和自有组件；锁文件中的 React 为 19.2.8、Vite 为 7.3.6。当前直接依赖没有第三方 Router、Server State 或 Data Grid；依赖树中某工具的间接出现不能算作已接入。根 Vitest 配置和 CI 的真实浏览器覆盖边界见[浏览器测试调研](./browser-testing)。

在 Node 24.18.0、pnpm 11.9.0 和当前冻结锁文件下，本次执行 `pnpm build` 成功。Vite 输出的主 JS 为 **561.46 kB，gzip 173.21 kB**，并出现超过 500 kB 的单 chunk 提示。这是当前生产构建基线，替代 issue 中的旧数值 552.45 kB；它不是下载耗时、运行时内存或任何候选库的增量体积。候选的性能与拆包收益仍需在同一构建条件下实测。

::: code-group

```bash [复核构建基线 ~vscode-icons:file-type-shell~]
pnpm install --frozen-lockfile
pnpm build
```

:::

当前 [`ModuleSurface`](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/web/src/ModuleSurface.tsx) 已分派 Storage、Wiki、Request、Record/Gate 和 Entity 页面，因此“没有领域检视页面”不成立。但按类型查找首个匹配组件并提前返回的行为仍存在；支持部分专用 Surface，不等于已支持 Manifest 的任意多区域组合。具体差异见 [Surface 调研](./surfaces)。

## 八个专题与条件建议

以下方向来自源码和一手文档比较，均需局部验证后才能形成正式选型；每个专题保留全部候选及不同条件下的取舍。

- [#233：数据库与领域数据检视](./data-inspection)——产品保留 Inspection 投影，独立开发检视优先评估 DBeaver Community，PostgreSQL 专项运维可评估 pgAdmin；嵌入管理台需另有集中运维需求。
- [#234：HTTP Client 与认证](./http-auth)——先以统一 Fetch 行为加运行时校验为基线；确需额外 hooks 或拦截能力时比较 Ky、Axios，OpenAPI 覆盖足够时再评价生成客户端。
- [#231：Server State](./server-state)——跨页面共享副本与生命周期时优先局部验证 TanStack Query，以 SWR 作读取场景的对照；没有独立 Redux 需求时，不仅为查询引入 RTK Query。
- [#230：路由与导航](./routing)——减少手写历史状态机时优先验证 React Router；类型化筛选深链接是首要目标时，同场景比较 TanStack Router。
- [#235：Inspection Surface](./surfaces)——先评价现有领域组件加显式覆盖检查；表单生成器适合动态字段子任务，Storybook 可用于状态示例，但两者都不代替运行时 Manifest 协议。
- [#236：数据表格与 Master-detail](./tables)——记录定位与证据阅读优先比较自有组件、TanStack Table 和 React Aria；复杂多列分析需求成立后，再比较完整网格与商业功能的收益。
- [#237：应用壳层与后台框架](./app-shell)——领域解释页占主要工作量时优先保留壳层、按层评价替换；常规资源管理增多后，再衡量 React Admin 或 Refine 的适配收益。
- [#232：真实浏览器测试](./browser-testing)——优先评估 Node Vitest 加 Playwright Test；组件交互需求增加时再引入 Vitest Browser，不同时引入多个重叠 runner。

## 跨专题的判断边界

**数据访问权限仍由服务端决定。** 数据库工具不能自动继承 Inspection 的脱敏、范围限制和领域投影；前端 Router、查询缓存和只读控件也不能代替服务端授权。候选采用与否不改变这项责任。

**HTTP 缓存与应用缓存需要分别评估。** Inspection 的 `Cache-Control: no-store` 约束 HTTP 缓存，不会自动清理 React 查询库保存的 JavaScript 对象。引入 Server State 前需要确认身份变化、401、取消、晚到结果与缓存退出之间的关系；凭据不能为了区分缓存而暴露到可分享地址或诊断产物。[HTTP 缓存指令](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control)、[TanStack Query 默认行为](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults)分别描述了这两层机制。

**cursor 的语义先于表格功能。** 一个页面只能拿到有界结果时，对本页排序或搜索不能被称为全库排序或搜索。是否支持总数、跳页、全量导出或任意排序，需要先核对服务端契约，再评价数据网格能力。

**领域语义和通用交互分别负责。** 通用组件可以承载加载、错误、分页、选择和布局；“一次门控为何醒来”“这条事实引用了谁”仍需要领域 DTO 和 renderer。表单生成器、后台资源框架与 Storybook 各自解决不同问题。

**浏览器证据是接入决策的一部分。** 静态 HTML 和纯函数测试不能证明真实历史栈、焦点恢复、窗口尺寸或请求取消行为。未来选择 Router、查询库或数据网格时，需要以同一组实际场景比较候选，不能用文档中的功能名称替代项目验证。

## 完成标准与后续工作

本轮 research 的完成标准是：八个专题均核对当前源码、覆盖 issue 所列候选、给出可追溯的一手来源，说明适用条件、成本和仍需验证的问题，并形成互不矛盾的汇总结论。研究交付通过文档 PR 审查；生产框架接入、数据库权限部署及真实浏览器测试接入分别属于后续实施。

后续决策宜先厘清认证与传输约定，并建立能观察浏览器行为的最小验证路径，再比较路由和 Server State 的实际接入；Surface 覆盖与分页语义明确后，才能有依据地选择通用列表能力。完整后台框架是否值得接管这些层，应由这些结果决定。这是调研得出的验证依赖关系，不是已批准的 Provider 顺序、URL 方案或迁移计划。
