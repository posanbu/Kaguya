# 用户配置管理

## Summary

新增统一的用户配置管理层，支持保存多份配置、设置默认配置，并按会话选择一个候选配置。每份配置包含 AI、平台和插件设置；候选必须通过 readiness，默认选择本身不代表可运行。

## Changes

- 新增 `@kaguya/config` TypeScript 包及配置 schema。
- 新增无副作用的 `inspect()` 引导和显式 `initialize()`；缺少 store 不再生成空 default profile，`open()` 改为返回 `CONFIG_SETUP_REQUIRED`。
- 初始化和会话解析要求至少两个不同的 `providerId:modelId` 目标；模型不完整时返回 `CONFIG_INCOMPLETE`。
- 支持配置的创建、读取、完整更新、删除和默认配置管理；完整更新会清除该 profile 的 warning 确认。
- 支持会话绑定、解绑和未绑定会话的 default profile 选择；解析只检查被选中的一个 profile，不能回退其他 profile、provider 或模型。
- 可选配置缺失会返回 `CONFIG_REVIEW_REQUIRED`；只有显示 warning 并得到明确用户确认后，初始化重试或 per-profile `acknowledgeConfigurationWarnings()` 才可记录确认。
- 使用敏感 JSON 文件持久化明文密钥，并提供原子写入、路径与符号链接防护、POSIX 权限加固、损坏检测和递归脱敏。
- 补充配置使用、安全边界和后续集成文档。

## Validation

- Vitest：247/247
- Promptfoo：4/4
- `pnpm lint`
- `pnpm build`
- `pnpm typecheck`
- 所有已跟踪文件通过 Prettier 检查

## Known limitations

- API key、平台凭据和插件密钥以明文 JSON 保存，整个配置根目录都必须作为敏感数据管理。
- 每个配置根目录只能有一个活跃的 manager/writer；当前不提供跨实例或跨进程协调。
- Windows 部署需要人工设置仅允许运行身份访问的 NTFS ACL。
- 配置 UI、模型提供方执行、平台适配器和插件运行时接线仍不在本次范围内；未来执行层会直接返回 provider 失败，不提供 fallback。
