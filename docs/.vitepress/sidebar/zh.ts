import type { DefaultTheme } from "vitepress";

export const zhSidebar: DefaultTheme.SidebarItem[] = [
  {
    text: "使用指南",
    items: [
      { text: "指南首页", link: "/zh/guide/" },
      { text: "安装与启动", link: "/zh/guide/installation" },
      { text: "配置 Kaguya", link: "/zh/guide/configuration" },
      { text: "使用 Web UI", link: "/zh/guide/webui" },
    ],
  },
  {
    text: "开发文档",
    items: [
      { text: "开发概览", link: "/zh/developers/" },
      { text: "文档编写规范", link: "/zh/developers/markdown-features" },
    ],
  },
  {
    text: "参考资料",
    items: [{ text: "参考入口", link: "/zh/reference/" }],
  },
  {
    text: "项目",
    items: [{ text: "路线图与状态", link: "/zh/project/" }],
  },
];
