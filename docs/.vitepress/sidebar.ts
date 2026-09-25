/**
 * 功能概述：按用户任务组织文档导航，将安装和配置与开发资料分开。
 * 主要职责：userGuide 提供入门、配置和日常使用目录；developerGuide 收纳架构、接口与设计资料。
 * 持续情境设计分组区分目标契约、已实现端口与迁移边界；Web 检视调研分组汇集八个研究专题，明确它们是决策资料而非已接入能力。
 * 代码库关系：config.mts 导入 sidebar，由 VitePress 按页面路径选择对应目录；新增页面在这里登记。
 * 输入输出与副作用：导出静态路由映射，没有运行期 I/O；旧 guide 调度页仍可访问并指向开发文档。
 */
import type { DefaultTheme } from "vitepress";

const userGuide: DefaultTheme.SidebarItem[] = [
  {
    text: "开始使用",
    items: [
      { text: "快速上手", link: "/guide/" },
      { text: "安装与启动", link: "/guide/installation" },
    ],
  },
  {
    text: "配置详解",
    items: [
      { text: "配置概览", link: "/guide/configuration" },
      { text: "模型配置", link: "/guide/models" },
      { text: "角色与回复风格", link: "/guide/persona" },
      { text: "接入 QQ（NapCat）", link: "/guide/napcat" },
      { text: "发言频率与等待", link: "/guide/reply-settings" },
      { text: "记忆配置", link: "/guide/memory" },
      { text: "模块配置", link: "/guide/modules" },
      { text: "运行参数", link: "/guide/runtime" },
    ],
  },
  {
    text: "日常使用",
    items: [
      { text: "网页管理与聊天", link: "/guide/webui" },
      { text: "跨会话消息", link: "/guide/message-targets" },
      { text: "更新与备份", link: "/guide/maintenance" },
      { text: "常见问题", link: "/guide/troubleshooting" },
    ],
  },
];

const developerGuide: DefaultTheme.SidebarItem[] = [
  {
    text: "开发文档",
    items: [
      { text: "开发概览", link: "/developers/" },
      { text: "持续 Agent 设计原则", link: "/developers/continuous-agent" },
      { text: "外部设计参考", link: "/developers/design-references" },
      { text: "运行时架构", link: "/developers/architecture" },
      { text: "信息模块 SDK", link: "/developers/information-modules" },
      { text: "Memory 认知层", link: "/developers/memory" },
      { text: "配置生命周期", link: "/developers/configuration-lifecycle" },
      { text: "信息账本", link: "/developers/information-ledger" },
      { text: "Runtime 可观测性", link: "/developers/observability" },
      { text: "一次性调度", link: "/developers/scheduler" },
      { text: "短心跳恢复", link: "/developers/heartbeat" },
      { text: "周期维护调度", link: "/developers/cadence" },
      { text: "参与贡献", link: "/developers/contributing" },
      { text: "文档编写规范", link: "/developers/markdown-features" },
    ],
  },
  {
    text: "持续情境设计与实现",
    collapsed: true,
    items: [
      { text: "公共契约与实施边界", link: "/developers/continuous/" },
      { text: "情境与观察", link: "/developers/continuous/observation" },
      {
        text: "经历与长期认识",
        link: "/developers/continuous/memory-formation",
      },
      { text: "决策与行动", link: "/developers/continuous/action-lifecycle" },
    ],
  },
  {
    text: "Web 检视调研",
    collapsed: true,
    items: [
      { text: "范围与结论总览", link: "/developers/research/" },
      {
        text: "数据库与领域检视",
        link: "/developers/research/data-inspection",
      },
      { text: "HTTP 与认证", link: "/developers/research/http-auth" },
      { text: "Server State", link: "/developers/research/server-state" },
      { text: "路由与导航", link: "/developers/research/routing" },
      { text: "Inspection Surface", link: "/developers/research/surfaces" },
      { text: "表格与 Master-detail", link: "/developers/research/tables" },
      { text: "应用壳层与后台框架", link: "/developers/research/app-shell" },
      { text: "真实浏览器测试", link: "/developers/research/browser-testing" },
    ],
  },
  {
    text: "接口参考",
    collapsed: true,
    items: [
      { text: "参考入口", link: "/reference/" },
      { text: "HTTP API", link: "/reference/http-api" },
      { text: "Profile API", link: "/reference/profile-api" },
      { text: "环境变量", link: "/reference/environment-variables" },
      {
        text: "启动配置校验",
        link: "/reference/startup-configuration-validation",
      },
    ],
  },
  {
    text: "设计与项目",
    collapsed: true,
    items: [
      { text: "界面设计", link: "/design/" },
      { text: "配置流程设计", link: "/design/configuration-flow" },
      { text: "状态与路线图", link: "/project/" },
    ],
  },
];

export const sidebar: DefaultTheme.Sidebar = {
  "/guide/": userGuide,
  "/developers/": developerGuide,
  "/reference/": developerGuide,
  "/design/": developerGuide,
  "/project/": developerGuide,
};
