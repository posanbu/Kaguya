# Kaguya 文档站

本目录是 Kaguya 的中文 VitePress 静态文档站。公开页面直接位于站点根路径，不再维护英文镜像或语言切换。

## 目录结构

- `guide/`：安装、配置与 Web UI 使用。
- `design/`：UI 目标、视觉原则与配置流程设计。
- `developers/`：架构、贡献流程和文档规范。
- `reference/`：HTTP API、Profile API、环境变量与公共契约。
- `project/`：当前边界与路线图。
- `.vitepress/`：站点配置、导航和主题。
- `public/`：项目图标与静态资源。
- `scripts/`：检查构建后的页面、站内锚点与静态资源引用。

## 当前事实与历史归档

现行文档以当前分支代码、测试、根 README、`CONTRIBUTING.md` 和各 package README 为依据；规划中的能力必须明确标记。主分支只维护当前文档，历史计划、实施报告和旧站资源不再存放在文档源码或公开资源目录。

历史资料整体保存在主分支之外的[冻结归档](https://github.com/posanbu/Kaguya/tree/3622c77bc3d3b9a947bb76082164095284cf6edb)，分支为 `archive/issue-116-legacy-docs`，来源提交为 `e663181b2617b2617fa075e4b450f11bf50e804f`。该独立归档不再更新、不合并回主分支，也不参与站点构建。归档 README 记录范围，`SHA256SUMS` 提供逐文件校验；下载页面上的提交快照即可整体恢复原始目录。

本次清理包含旧用户与插件文档、早期架构稿、日期化方案、实施记录、旧安装指南及未被当前文档引用的图片，共 228 个文件。当前首页与主题仍使用 `public/kaguya-logo.png`，因此保留。旧页面和静态资源 URL 不提供重定向、占位页或通配重写。

## 本地开发

使用仓库声明的 Node.js 24.18.0 和 pnpm 11.9.0，在本目录执行：

```bash
pnpm install
pnpm docs:dev
```

生产构建和预览：

```bash
pnpm docs:check
pnpm docs:preview
```

`docs:check` 先验证链接检查器，再执行 VitePress 构建及 Markdown 死链检查，最后检查生成页面的站内链接、锚点、HTML/CSS 资源引用和归档路径残留；任一失败都会返回非零退出码。PR 检查和发布工作流均运行此命令。GitHub Pages 使用 `/Kaguya/` 基础路径。

## 新增页面

1. 在对应中文栏目下新增 Markdown 文件。
2. 将路由加入 `.vitepress/sidebar.ts`。
3. 使用二、三级标题构成右侧页内目录。
4. 完成生产构建，并检查桌面端和移动端页面。
