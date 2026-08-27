import { defineConfig } from "vitepress";

export default defineConfig({
  base: "/Kaguya/",
  title: "Kaguya 文档",
  description: "Kaguya TypeScript AI Bot Runtime documentation",
  cleanUrls: true,
  themeConfig: { nav: [{ text: "中文", link: "/zh/" }, { text: "English", link: "/en/" }], sidebar: { "/zh/": [{ text: "文档", items: [{ text: "首页", link: "/zh/" }, { text: "架构", link: "/zh/develop/" }, { text: "配置", link: "/zh/manual/configuration/" }, { text: "Web UI", link: "/zh/manual/webui/" }] }], "/en/": [{ text: "Documentation", items: [{ text: "Home", link: "/en/" }, { text: "Architecture", link: "/en/develop/" }, { text: "Configuration", link: "/en/manual/configuration/" }, { text: "Web UI", link: "/en/manual/webui/" }] }] } }
});