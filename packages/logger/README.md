# `@kaguya/logger`

Kaguya 的统一 Pino 日志包，开发默认 pretty、生产默认 JSON，提供：

- `createLogger()`：创建带统一时间、级别、redaction 和安全 serializer 的根 Logger；
- `createModuleLogger()`：创建带 `module` 命名空间和独立级别规则的 child Logger；
- `runWithLogContext()` / `getLogContext()`：传播并读取 AsyncLocalStorage 链路上下文；
- `readLoggerOptions()`：读取统一日志环境变量；
- `flushLogger()` / `closeLogger()`：刷新并安全关闭同步或 worker destination；
- `toSafeError()`：只保留可安全聚合的错误分类字段。

pretty 仅支持同步 stdout/stderr；JSON 支持同步、worker transport 和文件 destination。完整用法、DAG/Prompt 展开、字段约定和安全边界见 [Runtime 与 Information 可观测性](../../docs/developers/observability.md)。

pretty 采用简短本地时间、显式级别与中文模块标题，并参考 MaiBot 独立 Rich Panel 的展示方式，为模块输入、领域输出和记忆事件绘制分区框。Planner Prompt 与决策、回复正文、记忆检索与写入、人物事实、表达习惯分别展示；普通启动和连接状态仍使用短日志。正文、业务字段和链路溯源分区显示，插件自定义消息和未知字段仍保留。边框按模块主题着色，并按终端宽度换行；重定向、`NO_COLOR` 或 `TERM=dumb` 环境保留无颜色的边框文本。

面板遵循现有日志级别，不引入 MaiBot 的 `show_maisaka_thinking` 开关。完整 Prompt、查询文本、记忆正文、人物事实详情及表达习惯在 `debug` 展开；候选只显示排名、原因和来源引用，原始记忆 writeback 只显示状态，不额外加载正文。查询和记忆正文预览先脱敏，再限制为最多 168 个 Unicode 码点。

格式化发生在 serializer/redaction 之后，JSON 保留机器可读的原始字段名、完整 ID 与引用；新增的 debug 查询／记忆正文投影同样会写入 JSON destination。面板本身不改变记录或日志级别。

在仓库根目录运行 `pnpm logs:preview` 可查看虚构的启动、Planner 输入输出、收发消息、记忆命中与空结果、写入终态、表达习惯及模型失败样例；`pnpm logs:preview --json` 可对照结构化输出。预览仅调用 logger 管线，无需启动 Server 或连接数据库。
