---
title: 数据表格与 Master-detail 调研
description: 比较列表基础设施的交互、许可与迁移边界，明确服务端 cursor 不等于本地数组分页。
---

# 数据表格与 Master-detail 调研

本文对应 [#236](https://github.com/posanbu/Kaguya/issues/236)，核验日期为 2026-09-25，代码基线为 [`2dad5c83`](https://github.com/posanbu/Kaguya/tree/2dad5c8330a6668e293f79995b2f477ce71ecc61)。目标是为列表选择、详情阅读与返回路径提供后续决策依据；本轮不确定列协议、分页 API、视觉样式或最终组件，也未接入候选原型。

## 先分清已经复用的能力与真实缺口

[InspectionPager](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/web/src/ModuleRuntimeSection.tsx#L232) 已用 cursor 历史实现上一页、下一页；Record、Request、Gate 分别保存列表和详情状态。[StorageSurface](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/web/src/StorageSurface.tsx) 已消费 Manifest 的声明列。因此不能说完全没有公共分页或列描述。缺口是尚无跨 Surface 的统一列行为、详情容器与完整键盘契约；领域摘要、长 JSON、Trace 也不能全部压成普通单元格。

[服务端 Surface 查询](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/server/src/inspection.ts#L655) 有界返回数据，校验 cursor 与筛选条件，当前参数没有任意排序字段。表格对本页排序不等于全库排序；启用列排序不能自行创造服务端能力。总数未知时也不能把“第几次翻页”解释为可随机跳转的全库页码。

issue 所列 552.45 kB 是旧构建值；本次主 JS 为 561.46 kB，gzip 173.21 kB，条件见[调研总览](./index)。这是比较候选的基线，不是任何网格的增量测量。

## 候选能力、许可与迁移成本

**TanStack Table。** Headless 状态与行模型可复用现有 React/CSS，支持列可见性、选择及受控排序、分页；DOM、样式、键盘与可访问语义由项目负责。`manualPagination` 接收已分页数据，`manualSorting` 接收已排序数据，均不会把页码自动转换成服务端 cursor。适合希望保留领域详情、只抽离列表状态的情况；不适合期待安装后即获得完整交互网格。虚拟化还需单独评价。[概述](https://tanstack.com/table/v8/docs/overview)、[分页](https://tanstack.com/table/v8/docs/guide/pagination)、[排序一致性](https://tanstack.com/table/v8/docs/guide/sorting)及 [MIT 许可](https://github.com/TanStack/table/blob/main/LICENSE)。

**AG Grid。** 提供完整网格交互与虚拟化，适合大量列操作及成熟数据分析需求，但要引入其组件、状态与主题。Community 为 MIT，可免费商业使用；Enterprise 需要商业许可，内置 Master/Detail 与 Server-Side Row Model 属于 Enterprise。不能据此误写“所有远程分页都收费”，Community 也可接收远程数据；具体行模型仍需适配 Kaguya 的有序 cursor。其行展开明细也不直接等于现有列表旁的领域详情页。[版本边界](https://www.ag-grid.com/react-data-grid/community-vs-enterprise/)、[Master/Detail](https://www.ag-grid.com/react-data-grid/master-detail/)。

**MUI X Data Grid。** 提供 Material UI 体系的完整表格；Community 为 MIT，Pro/Premium 为商业许可，官方 master-detail row panel 使用 `DataGridPro`。适合已经采用 MUI 或确实需要其网格能力的产品；Kaguya 当前采用 Radix 和自有 CSS，需要承担额外主题、依赖和状态适配成本。不能为获得一块详情面板就假设必须采购，也不能把商业示例算作 Community 能力。[组件文档](https://mui.com/x/react-data-grid/)、[详情面板](https://mui.com/x/react-data-grid/master-detail/)、[许可边界](https://mui.com/x/introduction/licensing/)。

**React Aria Table。** 提供可访问表格的选择、排序事件及键盘交互基础，保持无预设视觉样式，适合将交互语义作为主要缺口的情况。它不会自动决定服务器排序、cursor 生命周期、详情路由或 JSON 展示。迁移需将现有行组件接入其 collection 与受控状态，同时避免出现两套焦点管理。Apache-2.0 允许免费商业使用，需履行分发通知要求。[官方 Table](https://react-aria.adobe.com/Table)、[许可证](https://github.com/adobe/react-spectrum/blob/main/LICENSE)。

**自有 React primitives。** 可以继续复用 InspectionPager、领域组件和当前 CSS，最容易保持既有数据路径；但列隐藏、选择、焦点恢复和大列表性能均需自行维护。现有 [React](https://github.com/facebook/react/blob/main/LICENSE)、[Radix](https://github.com/radix-ui/primitives/blob/main/LICENSE) 为 MIT，无新增网格商业许可成本；缺少外部付费依赖不意味着长期维护免费。

## 条件建议与决策门槛

如果主要任务是找到一条记录并理解其证据，先比较自有 primitives、TanStack Table 和 React Aria 的边界；只有多列分析、批量编辑或复杂分组成为确定需求，才评价完整网格的收益。当前每页本就有界，不能仅因“记录总量大”便认定必须虚拟化。也不宜默认同时引入 Table 与 Aria，把状态同步成本隐藏在“组合使用”中。

后续应分别验证：翻页期间插入新记录是否重复或漏项；筛选变化是否清除旧 cursor；不支持的排序是否被误呈现；请求失败后能否保留原上下文；选中行消失、详情返回、窄屏切换与键盘操作是否合理。长 JSON 应与摘要、Trace 分开评价，另测屏幕阅读器、实际渲染量和生产包增量。候选 React peer dependency 与浏览器行为尚未在当前锁文件上做接入验证，以上判断不构成兼容性或性能通过声明。
