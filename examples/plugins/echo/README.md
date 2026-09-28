# 独立 Echo 插件

本包演示使用现有宿主能力安装模块。默认导出的声明工厂从 `host.kind()` 获取宿主入站文本 Kind；插件自行声明 `example.echo.record.v1`、设置 schema 和持久订阅，不导入宿主的一方模块目录。

每条 `core.message.inbound.text` Atom 是完整处理单位。处理器按原文 JavaScript 字符串长度生成一条 `{ label, length }` 记录，并通过 `core:caused-by` 和 `core:context` 引用保留来源。`label` 来自实例设置，默认值为 `echo`。本模块不调用模型、平台接口或数据库。

持久订阅由宿主可靠投递管理，`registerOnce` 使用实例 ID 和输入 Atom 构成稳定幂等身份；重放不会生成第二条结果。订阅停用后不处理新输入，历史记录继续保留。包声明版本为 `1.0.0`；改变持久 payload 契约应发布新 Kind 版本，并通过插件 `compatibility` 声明旧版本读取转换。

安装命令、`cordis.yml` 示例及显式应用行为见仓库文档 `docs/developers/information-modules.md`。先构建宿主，再把同版本 `@kaguya/sdk`、`@kaguya/schema` 链接到配置根，并通过 `pnpm add file:<本包目录>` 安装。本目录也可直接执行 `npm pack` 生成独立安装包。
