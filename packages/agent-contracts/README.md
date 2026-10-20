# @kaguya/agent-contracts

0.1.0 提取 Kaguya 当前运行代码中的 Light 目标/动作校验和图存储节点/关联校验。该包只依赖 Zod，不依赖运行框架、模型 SDK 或数据库。

提取基线与原路径见 provenance.json。旧模块继续重新导出相同对象。此包不实现自动记忆形成、观察水位、失败恢复策略或主行动线。DSH 先行能力保留在对应插件。

在仓库根执行 `pnpm exec tsc -b packages/agent-contracts`。分发时使用固定版本的 tarball，并记录 SHA-256。来源提交是提取基线，不表示该提交已包含本包。
