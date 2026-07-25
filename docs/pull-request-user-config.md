# 用户配置管理

## Summary

新增统一的用户配置管理层，支持保存多份配置、设置默认配置，并按会话选择使用的配置。每份配置包含 AI、平台和插件设置。

## Changes

- 新增 `@kaguya/config` TypeScript 包及配置 schema。
- 支持配置的创建、读取、完整更新、删除和默认配置管理。
- 支持会话绑定、解绑，以及未绑定会话的默认配置回退。
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
- 配置 UI、模型提供方执行、平台适配器和插件运行时接线仍不在本次范围内。
