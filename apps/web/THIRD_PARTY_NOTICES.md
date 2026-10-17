# 记忆图界面的复用来源

`src/MemoryGraphCanvas.tsx` 基于 [vasturiano/react-force-graph](https://github.com/vasturiano/react-force-graph) 的官方高亮示例改写，固定来源提交为 `8c301c7a05b22c489b5724301bec52911b51d966` 的 `example/highlight/index.html`。有向箭头与曲线行为沿用同仓库提供的图组件接口。

复用部分包括二维力导向图、悬停邻域高亮、节点绘制和节点／边选择。Kaguya 将其适配为 Obsidian 风格的小圆点、细线与按需标签，并接入 PostgreSQL 记忆快照及手动管理接口。当前使用 `react-force-graph-2d`，图引擎只修改独立的视图数据副本。

示例采用 MIT 许可，Copyright (c) 2018 Vasco Asturiano。完整许可见 [licenses/react-force-graph.txt](licenses/react-force-graph.txt)。依赖库的许可证随各 npm 包分发。
