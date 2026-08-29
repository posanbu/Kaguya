# 用户配置管理

## Summary

`@kaguya/config` 保存多份 AI、平台和插件配置，并提供默认 Profile 与按明确
`profileId` 选择的读取接口。配置选择不从消息来源或用户身份推导。

## Current contract

- `inspect()` 无副作用地返回配置就绪状态，`initialize()` 显式创建第一份 Profile。
- 索引格式为 v2，只保存 `defaultProfileId` 和 Profile 元数据；Profile 文件格式仍为 v1。
- `resolveProfileById(profileId?)` 解析明确指定或默认 Profile，不回退其他 Profile、provider 或模型。
- 完整更新会清除 warning 确认；重新使用前必须再次检查并显式确认。
- 明文密钥只写入权限保护的敏感 JSON 文件，写入具备原子替换、路径和符号链接防护。
- v1 索引以 `CONFIG_UNSUPPORTED_VERSION` 拒绝，不自动迁移或删除；用户必须先备份再重新初始化。

## Known limitations

- 每个配置根目录只能有一个活跃 writer，当前不提供跨进程协调。
- Windows 部署需要人工设置仅允许运行身份访问的 NTFS ACL。
- 配置 UI 和 secret manager 集成不在配置包内。
