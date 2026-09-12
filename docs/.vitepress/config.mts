/**
 * 功能概述：配置 Kaguya 中文文档站的路由、导航、搜索、Markdown 扩展与主题。
 * 主要职责：默认导出经 withMermaid 包装的 VitePress 配置；markdown.config 安装
 * 代码组图标和时间线插件，groupIconVitePlugin 为构建提供图标资源。
 * 代码库关系：导航复用 sidebar.ts，品牌图片来自 public/kaguya-logo.png；
 * docs:dev、docs:build 和 docs:check 均读取本配置，GitHub Pages 使用 /Kaguya/。
 * 输入输出与副作用：从当前 Markdown 生成页面及本地搜索索引；仅排除仓库说明文件，
 * 历史资料已移出站点源码，不通过排除规则、重定向或忽略死链保留旧内容。
 */
import { defineConfig } from "vitepress";
import timeline from "vitepress-markdown-timeline";
import {
  groupIconMdPlugin,
  groupIconVitePlugin,
} from "vitepress-plugin-group-icons";
import { withMermaid } from "vitepress-plugin-mermaid";

import { sidebar } from "./sidebar";

export default withMermaid(
  defineConfig({
    lang: "zh-CN",
    base: "/Kaguya/",
    cleanUrls: true,
    lastUpdated: true,
    srcExclude: ["AGENTS.md", "README.md"],
    title: "Kaguya 文档",
    description: "事件驱动、模块可插拔的 TypeScript AI Bot Runtime 文档",
    head: [
      ["meta", { name: "theme-color", content: "#df6f28" }],
      [
        "link",
        { rel: "icon", type: "image/png", href: "/Kaguya/kaguya-logo.png" },
      ],
    ],
    themeConfig: {
      logo: "/kaguya-logo.png",
      siteTitle: "Kaguya",
      nav: [
        { text: "界面设计", link: "/design/" },
        { text: "使用指南", link: "/guide/" },
        { text: "开发文档", link: "/developers/" },
        { text: "参考资料", link: "/reference/" },
        { text: "项目", link: "/project/" },
      ],
      sidebar,
      search: { provider: "local" },
      outline: { level: [2, 3], label: "本页目录" },
      docFooter: { prev: "上一页", next: "下一页" },
      lastUpdated: { text: "最后更新" },
      returnToTopLabel: "返回顶部",
      sidebarMenuLabel: "文档导航",
      darkModeSwitchLabel: "外观",
      socialLinks: [
        { icon: "github", link: "https://github.com/posanbu/Kaguya" },
      ],
      editLink: {
        pattern: "https://github.com/posanbu/Kaguya/edit/main/docs/:path",
        text: "在 GitHub 上编辑",
      },
      footer: {
        message: "事件驱动、模块可插拔的 TypeScript AI Bot Runtime",
        copyright: "Kaguya contributors",
      },
    },
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
        primaryColor: "#fff0df",
        primaryTextColor: "#653016",
        primaryBorderColor: "#df6f28",
        lineColor: "#d96b27",
        secondaryColor: "#ffe0b8",
        tertiaryColor: "#fff9f1",
      },
    },
    vite: {
      plugins: [groupIconVitePlugin()],
    },
  }),
);
