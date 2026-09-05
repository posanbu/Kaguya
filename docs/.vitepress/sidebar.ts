import type { DefaultTheme } from "vitepress";

export const sidebar: DefaultTheme.SidebarItem[] = [
  {
    text: "界面设计",
    items: [
      { text: "设计概览", link: "/design/" },
      { text: "配置流程设计", link: "/design/configuration-flow" },
    ],
  },
  {
    text: "使用指南",
    items: [
      { text: "指南首页", link: "/guide/" },
      { text: "安装与启动", link: "/guide/installation" },
      { text: "配置 Kaguya", link: "/guide/configuration" },
      { text: "使用 Web UI", link: "/guide/webui" },
      { text: "故障排查", link: "/guide/troubleshooting" },
    ],
  },
  {
    text: "开发文档",
    items: [
      { text: "开发概览", link: "/developers/" },
      { text: "运行时架构", link: "/developers/architecture" },
      { text: "配置生命周期", link: "/developers/configuration-lifecycle" },
      { text: "信息账本", link: "/developers/information-ledger" },
      { text: "参与贡献", link: "/developers/contributing" },
      { text: "文档编写规范", link: "/developers/markdown-features" },
    ],
  },
  {
    text: "参考资料",
    items: [
      { text: "参考入口", link: "/reference/" },
      { text: "HTTP API", link: "/reference/http-api" },
      { text: "Profile API", link: "/reference/profile-api" },
      { text: "环境变量", link: "/reference/environment-variables" },
    ],
  },
  {
    text: "项目",
    items: [{ text: "状态与路线图", link: "/project/" }],
  },
];
