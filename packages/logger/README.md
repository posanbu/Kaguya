# `@kaguya/logger`

Kaguya 的 Pino 结构化日志包，提供：

- `createLogger()`：创建带统一时间、级别、redaction 和安全 serializer 的根 Logger；
- `createModuleLogger()`：创建带 `module` 命名空间和独立级别规则的 child Logger；
- `runWithLogContext()` / `getLogContext()`：传播并读取 AsyncLocalStorage 链路上下文；
- `readLoggerOptions()`：读取统一日志环境变量；
- `flushLogger()` / `closeLogger()`：刷新并安全关闭同步或 worker destination；
- `toSafeError()`：只保留可安全聚合的错误分类字段。

完整用法、字段约定、环境变量、同步/异步取舍和安全边界见 [结构化日志](../../docs/logging.md)。
