# Kaguya WebUI

<!-- impeccable:product-schema 1 -->

## Platform

web

## Product Purpose

提供 Kaguya 的管理工作台。当前记忆管理需求是检视 PostgreSQL 中的记忆内容，并手动新增、编辑、删除节点与关系。

## Capabilities and Constraints

记忆节点只有 ID、metadata 字典和正文三列。metadata 保存出现时间和标签。边有方向，并保留关系类型。用户要求从 GitHub 复用已有图编辑模板；图视图采用 Obsidian 风格的小圆点、细线和力导向布局，复用 react-force-graph 官方示例，融入现有 React 工作台。自动提取及模型召回由独立运行流程决定。

## Evidence on Hand

`src/components/AppShell.tsx` 提供现有工作台与导航，`src/styles.css` 及 `src/components/workbench.css` 提供现有样式。`THIRD_PARTY_NOTICES.md` 记录模板来源。
