## 动手前必读

1. 修改公开文档前先读 `developers/markdown-features.md`。
2. 文档站只维护中文，不创建英文镜像或语言切换。
3. 新增页面后必须更新 `.vitepress/sidebar.ts`，必要时同步调整顶部导航。
4. 图片放在 `public/images/`；站点级品牌资源直接放在 `public/`。
5. 内容页避免 Markdown 表格，优先使用“粗体字段名 — 说明”的定义式写法。
6. 独立代码示例放进 `::: code-group`，标签显式指定 Iconify 图标。

## 仓库地图

- `.vitepress/`：VitePress 配置、侧栏、主题和插件。
- `guide/`：面向使用者的安装、配置与 Web UI 文档。
- `developers/`：架构、贡献流程与写作规范。
- `reference/`：API、环境变量和公共契约。
- `project/`：当前状态、边界与路线图。
- `public/`：站点图标和静态资源。
- `zh/`、`ours/`：历史资料，仅用于迁移核对，由 `srcExclude` 排除。

## 内容事实

文档必须以当前代码、根 README、`CONTRIBUTING.md` 和各 package README 为依据。规划中的能力必须标为规划，不得写成已经可用。公开接口、事件、环境变量或启动方式变化时，同一提交更新对应页面。
