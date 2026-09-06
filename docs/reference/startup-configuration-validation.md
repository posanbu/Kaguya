# 启动配置校验

`@kaguya/config` 提供 `validateStartupConfiguration()`，用于在服务创建运行时之前检查 Profile Registry。校验函数只读取配置，不会创建目录、修改 Profile，也不会启动 HTTP、Runtime 或平台适配器。

## 校验结果如何表达

校验成功时返回选中的 Profile、配置根目录和经过 schema 校验的 `runtime` 配置：

```ts
const validated = await validateStartupConfiguration({
  rootDir: ".data/kaguya-config",
});

validated.runtime.port;
validated.profile.ai;
```

校验失败时抛出 `StartupConfigurationError`。错误包含 `code`、`path`、`message` 和可选的 `hint`，可直接用于终端摘要或结构化日志。错误摘要只描述字段和修复方向，不包含 API key、access token 或完整凭据。

## 校验范围

校验按照配置依赖关系分为几个层次：

- Registry：确认 `index.json`、Profile 版本和 selected Profile 可以安全读取；
- Profile：检查 AI provider、模型层级、平台条目和插件条目的 schema；
- Runtime：检查监听地址、端口、PostgreSQL database URL、路径、网关令牌、CORS、代理信任、限流和日志参数；
- Adapter：对已启用的 NapCat 条目检查 `ws://`/`wss://` 地址、`adapterId`、重连间隔和凭据类型。

至少一个已启用的非 Web 平台是运行前置条件。Web UI 属于内建适配器，不满足这一条件；插件可以为空，但非法插件结构仍会报告错误。

## 配置来源与安全边界

运行参数位于 Profile 的 `runtime` 字段，配置根目录仍由调用方传入，默认定位由服务层负责。旧的服务环境变量不会由此模块解析或迁移。

Profile 文件可能包含明文凭据。调用方应只记录校验 issue 的脱敏摘要，不要把 `profile`、原始异常或配置文件正文写入日志。
