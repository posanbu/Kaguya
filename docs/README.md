# Kaguya 文档站

本目录是 Kaguya 的中文 VitePress 静态文档站。公开页面直接位于站点根路径，不再维护英文镜像或语言切换。

## 目录结构

- `guide/`：安装、配置与 Web UI 使用。
- `developers/`：架构、贡献流程和文档规范。
- `reference/`：HTTP API、环境变量与公共契约。
- `project/`：当前边界与路线图。
- `.vitepress/`：站点配置、导航和主题。
- `public/`：项目图标与静态资源。
- `zh/`、`ours/`：旧资料，仅供核对和迁移，不参与构建。

## 本地开发

使用仓库声明的 Node.js 24.18.0 和 pnpm 11.9.0，在本目录执行：

```bash
pnpm install
pnpm docs:dev
```

生产构建和预览：

```bash
pnpm docs:build
pnpm docs:preview
```

GitHub Pages 使用 `/Kaguya/` 基础路径。

## 新增页面

1. 在对应中文栏目下新增 Markdown 文件。
2. 将路由加入 `.vitepress/sidebar.ts`。
3. 使用二、三级标题构成右侧页内目录。
4. 完成生产构建，并检查桌面端和移动端页面。
