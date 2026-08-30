import { defineConfig } from "vitepress";
import timeline from "vitepress-markdown-timeline";
import {
  groupIconMdPlugin,
  groupIconVitePlugin,
} from "vitepress-plugin-group-icons";
import { withMermaid } from "vitepress-plugin-mermaid";

import { enSidebar } from "./sidebar/en";
import { zhSidebar } from "./sidebar/zh";

const legacyContent = [
  "AGENTS.md",
  "README.md",
  "ours/**",
  "zh/about/**",
  "zh/changelog/**",
  "zh/develop/**",
  "zh/faq/**",
  "zh/features/**",
  "zh/manual/**",
  "zh/plugin/**",
  "en/about/**",
  "en/changelog/**",
  "en/develop/**",
  "en/faq/**",
  "en/features/**",
  "en/manual/**",
  "en/plugin/**",
];

const sharedTheme = {
  logo: "/kaguya-mark.svg",
  siteTitle: "Kaguya",
  search: { provider: "local" as const },
  socialLinks: [
    { icon: "github" as const, link: "https://github.com/posanbu/Kaguya" },
  ],
  editLink: {
    pattern: "https://github.com/posanbu/Kaguya/edit/main/docs/:path",
    text: "在 GitHub 上编辑 / Edit on GitHub",
  },
};

export default withMermaid(
  defineConfig({
    base: "/Kaguya/",
    cleanUrls: true,
    lastUpdated: true,
    srcExclude: legacyContent,
    title: "Kaguya Documentation",
    description: "Documentation for the Kaguya TypeScript AI Bot Runtime",
    head: [
      ["meta", { name: "theme-color", content: "#7c5cff" }],
      ["link", { rel: "icon", href: "/Kaguya/kaguya-mark.svg" }],
    ],
    locales: {
      root: {
        label: "简体中文",
        lang: "zh-CN",
        link: "/zh/",
        title: "Kaguya 文档",
        description: "Kaguya TypeScript AI Bot Runtime 文档",
        themeConfig: {
          nav: [
            { text: "使用指南", link: "/zh/guide/" },
            { text: "开发文档", link: "/zh/developers/" },
            { text: "参考资料", link: "/zh/reference/" },
            { text: "项目", link: "/zh/project/" },
          ],
          sidebar: zhSidebar,
          outline: { level: [2, 3], label: "本页目录" },
          docFooter: { prev: "上一页", next: "下一页" },
          lastUpdated: { text: "最后更新" },
          returnToTopLabel: "返回顶部",
          sidebarMenuLabel: "文档导航",
          darkModeSwitchLabel: "外观",
          footer: {
            message: "事件驱动、模块可插拔的 TypeScript AI Bot Runtime",
            copyright: "Kaguya contributors",
          },
        },
      },
      en: {
        label: "English",
        lang: "en-US",
        link: "/en/",
        title: "Kaguya Docs",
        description: "Documentation for the Kaguya TypeScript AI Bot Runtime",
        themeConfig: {
          nav: [
            { text: "Guide", link: "/en/guide/" },
            { text: "Development", link: "/en/developers/" },
            { text: "Reference", link: "/en/reference/" },
            { text: "Project", link: "/en/project/" },
          ],
          sidebar: enSidebar,
          outline: { level: [2, 3], label: "On this page" },
          docFooter: { prev: "Previous", next: "Next" },
          lastUpdated: { text: "Last updated" },
          returnToTopLabel: "Return to top",
          sidebarMenuLabel: "Documentation menu",
          darkModeSwitchLabel: "Appearance",
          footer: {
            message: "An event-driven, pluggable TypeScript AI Bot Runtime",
            copyright: "Kaguya contributors",
          },
        },
      },
    },
    themeConfig: sharedTheme,
    markdown: {
      lineNumbers: true,
      config(md) {
        md.use(groupIconMdPlugin);
        md.use(timeline);
      },
    },
    mermaid: {
      theme: "base",
      themeVariables: {
        primaryColor: "#ede9fe",
        primaryTextColor: "#30285f",
        primaryBorderColor: "#8b7cf6",
        lineColor: "#8b7cf6",
        secondaryColor: "#dcf8f2",
        tertiaryColor: "#f7f5ff",
      },
    },
    vite: {
      plugins: [groupIconVitePlugin()],
    },
  }),
);
