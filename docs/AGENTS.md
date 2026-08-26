## 动手前必读

动文档前按下列 5 条自检，任何一条不符都不算完。

1. **先读** [`zh/develop/markdown-features.md`](zh/develop/markdown-features.md) —— VitePress Markdown 写法（图标、代码组、禁止包裹、可选组件）权威文件
2. **修改 `zh/` 内容页 → 同 PR 内必须同步 `en/` 镜像**（术语/代码/文件名同步，散文可重写）
3. **新增文档页面**：写文件后必须改 `.vitepress/sidebar/zh.ts` 与 `.vitepress/sidebar/en.ts`，必要时再改 `.vitepress/config.mts` 顶部导航，否则前端不出现
4. **图片放 `public/images/...`，正文里以 `/images/...` 引用**；角色头像/标题图分别放 `public/avatars/`、`public/title_img/`
5. **内容页禁止 Markdown 表格** —— 表格渲染差且移动端列宽不可控，改用定义列表（`**field** — 说明`）。仅 `index.md` 首页允许表格

**禁止速查**

- ❌ 内容页用 `| A | B |` 表格 → ✅ `**A** — B` 定义列表
- ❌ 裸 ``` ```toml ``` fence → ✅ 包在 `::: code-group` 内，标签带 `~vscode-icons:file-type-toml~` 内联图标
- ❌ 标签依赖关键词自动匹配图标 → ✅ 显式 `~vscode-icons:<id>~`

---

## 仓库地图

按目录说明"这里应放什么方向的内容"；具体文件不再逐条列举。

### `.vitepress/` — 站点配置与主题

- **`config.mts`** — 顶部导航、搜索、多语言、markdown 插件注册（Mermaid、Tabs）、社交链接的入口
- **`sidebar/zh.ts` / `sidebar/en.ts`** — 中英文侧边栏导航结构，新增文档必改这两处
- **`theme/`** — 自定义主题（`index.ts` 入口、`style.css` 样式、`components/` Vue 组件）

### `zh/` — 中文文档（权威版）

中文为**内容源**，任何变更以 `zh/` 为先。下述子目录各自承载一类面向读者的内容方向：

- **`index.md`** — VitePress 首页 / Hero
- **`manual/`** — **用户手册**：面向最终读者，讲部署、配置、适配器、功能详解、WebUI、快速入门
  - `deployment/` 部署与安装概览、一键脚本、源码、Docker、installation-agent
  - `adapters/` 平台适配器（NapCat、GoCQ、Discord、Telegram、Snowluma 等）
  - `configuration/` Bot 配置、模型配置、Amemorix 配置、MCP 配置、模型附加参数
  - `features/` 用户视角功能详解（消息管线、Maisaka 推理、记忆、学习、表情、MCP）
  - `webui/` WebUI 使用（配置/记忆/插件/统计）
  - `index.md` 快速上手（承担手册首页与新手引导职能，替代已删除的 getting-started）
- **`develop/`** — **开发文档**：面向贡献者，讲技术栈、架构、贡献规范
  - `architecture.md` / `architecture/` 架构总览与 12 篇架构详解（消息管线、Maisaka、记忆、情绪、event-bus、tool-system、prompt-templates、service-layer、global-managers、webui-internals、mcp-integration、emoji-internals、expression-learning）
  - `contributing.md` 贡献指南 / `markdown-features.md` Markdown 写法权威
- **`plugin/`** — **插件开发文档**（权威统一入口）：manifest、lifecycle、tools、commands、hooks、event-handlers、api-components、message-gateway、actions、config、api-reference、home-cards、llmprovider、vibe-coding
- **`features/`** — 首页特性卡片内容（面向落地页的精简功能亮点）
- **`changelog/`** — 更新日志（按版本号命名，如 `v1-0-0.md`，首页用 `::: timeline` 渲染）
- **`faq/`** — 常见问题与故障排除（分类覆盖部署、对话回复、记忆学习、模型 API、适配器、一键脚本、插件、备份迁移、错误排查）
- **`about/`** — **项目元信息与法律**：关于 MaiBot、关于本文档、交流群、致谢与链接、最终用户许可协议（EULA）、用户隐私条款（PRIVACY）

### `en/` — 英文版文档（镜像）

结构镜像 `zh/`，通过翻译得来，应最大程度与中文内容保持同步。详细差异以 `zh/` 为准。

### `public/` — 静态资源

- **`images/`** — 截图与示意文档用图
- **`title_img/`** — 首页标题图
- **`avatars/`** — 角色/头像图片
- **`installation-agent.md`** — 给 AI agent 阅读的安装引导，**非读者文档**，保留在 public，勿迁移

---

## 代码块图标约定

完整写法、图标映射、禁止包裹规则（S1–S5）、en 镜像约定 → 见 [`zh/develop/markdown-features.md`](zh/develop/markdown-features.md) "代码组强制写法与禁止包裹"一节。

**核心原则一句话**：全站独立 fenced block 已统一转为单标签 `::: code-group` 配内联 `~vscode-icons:<id>~` 图标，不依赖关键词匹配。