# Issues #170–#173 验证记录

本分支基于 main 的 `5064a8b`，在独立工作树实现并联合验证四项改动。

- #170：关注生命周期落账、普通后续输入投影、跨 scope 隔离、过期恢复原评分、硬门禁、成功参与续租及失败关闭。真实 PGlite 测试覆盖调度恢复与终态，合并旧提名输入不重新开租。
- #171：真实 canonical scope 的用户来源批次、受限抽象模式、来源核验、唯一来源计数、空选择及独立 Prompt provenance。重启后复用持久化请求/终态；表达只影响语言表面形式。
- #172：Kind 分域并保留稳定入口与对象身份；Heartflow 分离账本水合和纯状态投影，Heartbeat 分离观察投影；新增 Manifest 信息流、消息阶段摘要、脱敏 trace 导出、配置错误定位与分层测试入口。
- #173：页面说明按需展开，状态图标/底色、主次/危险按钮层次，模块列表与详情的信息密度、响应式拓扑；顶栏保留编辑、当前选择与已生效的独立语义。

## 验证结果

- `pnpm build`：通过 TypeScript 项目构建与 Web 生产构建。
- `pnpm lint`：通过。
- 变更文件及新增源码的 `prettier --check`：通过。
- `pnpm exec vitest run --exclude '**/.worktrees/**'`：113 个测试文件通过，3 个按条件跳过；1104 项通过，45 项按条件跳过。
- 在 docs 目录运行 `pnpm docs:check`：构建通过；28 个页面、2239 个站内引用检查通过。
- Chrome 浏览器使用固定 Inspection/Profile/Adapter DTO 检查实际页面：1440px 与 390px，无页面异常、无横向溢出；列表、拓扑与概览共保存 5 张截图。

截图使用测试数据，不代表真实 QQ 投递或在线模型的风格效果验证。本轮未修改正在使用的配置文件；已有 modules 目录需显式补充 attention-focus.default 与 expression.default，详见配置文档。当前表达模式采用受限场景/风格类别，不保存任意原文句式。

#172 中 schema 迁移、容量治理、retention、全量投影修复按原审计定位继续作为后续独立工作。

## 界面截图

[桌面模块列表](modules-1440.png) · [窄屏模块列表](modules-390.png)

[桌面模块拓扑](topology-1440.png) · [窄屏模块拓扑](topology-390.png)

[桌面概览](overview-1440.png)
