---
title: Inspection Surface 描述与渲染调研
description: 核对 Manifest 与实际 renderer 的差异，比较注册表、表单生成器和组件开发工具。
---

# Inspection Surface 描述与渲染调研

本文完成 [#235](https://github.com/posanbu/Kaguya/issues/235) 的问题核查与候选比较。核验日期为 2026-09-25，代码基线为 [`2dad5c83`](https://github.com/posanbu/Kaguya/tree/2dad5c8330a6668e293f79995b2f477ce71ecc61)。以下建议供后续决策，不定义 Manifest 新版本、注册接口或布局规则，也未运行候选接入原型。

## 当前问题是描述覆盖与领域解释之间的差距

开发者通过 Surface 找到模块记录，再沿证据理解一次处理。Manifest 描述字段与布局，但“字段合法”“组件被渲染”“领域含义正确”是三个不同条件。当前 [Schema](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/packages/schema/src/inspection.ts#L184) 接受 `stack`、`sections`、`master-detail`、`responsive-grid` 和多个 area、component；这不意味着 Web 已按这些声明组合页面。

[ModuleSurface](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/web/src/ModuleSurface.tsx#L46) 仍按 storage、wiki、request、record、entity 的优先级查找并提前返回；同类型也只取首个。实体页面另取一个 mechanism。服务端 [findSurface](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/server/src/inspection.ts#L220) 则按数组顺序选择首个 entity、record、request 或 wiki browser，并单独查找 status；storage 使用独立查询入口。两侧选取规则不同，多 browser 声明存在匹配风险，不能仅靠换 renderer 库解决。

需要修正 issue 的历史语境：[PR #239](https://github.com/posanbu/Kaguya/pull/239) 后已有 Storage 声明列、Wiki 阅读器和隐藏无关通用区块的能力。不能将其描述成“所有声明都无效”。尚存的问题是缺少任意多区域组合的执行路径，以及通用层仍包含“人物”“原始记忆”等领域文案。已知但未被当前分派覆盖的组合，可能没有明确反馈；未知 type 则首先受到 Zod 联合类型约束，不能一概称为被 Web 静默忽略。

## 候选分别解决哪一层

**Zod 加自有 React renderer registry。** [Zod](https://zod.dev/) 验证描述与 DTO；项目维护 type 到受控组件的映射。适合保留 Gate、Request、Wiki 的领域组件，逐步核对覆盖关系。代价是布局、版本兼容、错误解释和组件覆盖均由项目负责；Zod 本身不会生成界面。[MIT 许可证](https://github.com/colinhacks/zod/blob/main/LICENSE) 允许免费商业使用，需保留声明。注册表模式不是独立收费框架，也不是当前代码中已经完成的通用注册机制。

**JSON Forms。** 官方以 JSON Schema 描述数据，以 UI Schema 描述布局、显隐及控件，并支持自定义 renderer、只读展示。适合结构稳定、接近表单的属性检视；若用于请求 Trace，需要转换现有 Zod/Manifest、提供自有 renderer 并处理数据获取，不能把 readonly 表单当作领域检视成品。React 集成可嵌入现有页面，但采用现成主题还需评价与 Radix/CSS 的重叠。核心为 MIT；商业服务不属于免费库承诺。[架构与能力](https://jsonforms.io/docs/)、[许可证](https://github.com/eclipsesource/jsonforms/blob/master/LICENSE)。

**react-jsonschema-form。** 核心目标是由 JSON Schema 生成 React 表单，支持 `uiSchema`、主题和自定义控件，需要配套 validator。适合动态配置字段；对只读时间线、证据关系和多请求追踪，需要额外领域组件，未必减少维护量。现有 Zod 校验与其表单校验也需明确各自责任。采用 Apache-2.0，可免费商业使用，分发时遵守许可与通知要求。[官方介绍及许可](https://rjsf-team.github.io/react-jsonschema-form/docs/)。

**Storybook。** 提供独立组件开发、状态示例和交互测试入口，适合展示空库、错误、超长字段等难以稳定复现的 Surface 状态。它可与上述任何方案并用，不提供运行时 Manifest 协议，也不能单独修复分派缺口。React/Vite 有官方集成，维护成本主要是 fixture、stories 与测试环境。开源部分为 MIT；是否购买外部托管或视觉测试服务另行判断。[官方文档](https://storybook.js.org/docs)、[许可证](https://github.com/storybookjs/storybook/blob/next/LICENSE)。

## 条件建议与待验证场景

若目标仍是解释已有领域 DTO，优先比较“现有组件加显式覆盖检查”的成本；若未来需求主要变成大量可编辑动态字段，再针对该子任务评价 JSON Forms 或 RJSF。Storybook 可独立评价，不能作为 renderer 的替代选项。这些是研究判断，尚未正式选型。

决策前应使用同一组声明与数据，验证多 browser、重复 area、仅 status/mechanism、非法 type、合法但未支持的组合，以及长文本和空关系的结果；尤其确认 Server 选取的数据与 Web 展示对象一致。另需检查模块切换后的选中对象、详情返回的焦点、窄屏阅读与 401，避免组件复用打断证据追溯。精确 React peer dependency、生产增量体积与实际交互均需在拟锁定版本上验证；本轮仅核对源码和一手文档。
