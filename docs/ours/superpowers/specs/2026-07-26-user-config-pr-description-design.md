# 用户配置管理 PR 描述设计

## 目标

创建一份可直接粘贴到 GitHub Pull Request 的简短中文描述，只介绍用户配置管理功能，不包含 Kaguya 仓库初始化工作。

## 文档结构

最终文档写入 `docs/pull-request-user-config.md`，采用以下四段式结构：

1. `Summary`：概括多配置文件、默认配置和按会话选择能力。
2. `Changes`：列出配置模型、安全文件存储、生命周期 API、会话绑定及配套文档。
3. `Validation`：记录最终通过的 Vitest、Promptfoo、lint、build 和 typecheck。
4. `Known limitations`：说明密钥为明文 JSON、每个配置根目录只能有一个活跃 manager/writer，以及 Windows 需要配置 NTFS ACL。

## 内容约束

- 保持简短，避免展开实现细节或逐条罗列提交。
- 不包含项目初始化、monorepo 搭建或其他非配置功能。
- 不写入真实密钥、内部审查过程或本地环境路径。
- 不声称已推送、已创建 PR 或已提供配置 UI、模型执行及平台/插件接线。
- 使用当前已经验证的测试数字和实现边界。

## 验收标准

- 内容能够直接复制到 GitHub PR 描述框。
- 已实现能力、测试证据和已知限制表达准确。
- 文档不包含占位符、未完成段落或与现有配置文档冲突的描述。
