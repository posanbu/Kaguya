/**
 * 功能概述：导出 MCP 宿主连接、严格配置和来源信封的公开入口。
 * Server 通过 McpHost 注入 W3 provider/工具快照；W8 可复用同一持久连接与按需资源接口。
 * 本文件只导出声明，导入时不读取凭据、不启动进程、不连接远端或注册模型工具。
 */
export { McpHost, type McpPromptSelection } from "./host.js";
export {
  McpConnection,
  type McpEnvelope,
  type McpSource,
  type McpRequestTrace,
} from "./connection.js";
export {
  McpError,
  mcpConfigurationSchema,
  mcpConnectionSchema,
  mcpProtocolSchema,
  loadMcpConfiguration,
  type McpConfiguration,
  type McpConnectionConfig,
} from "./config.js";
export {
  mcpResourcesCapability,
  mcpPromptsCapability,
  type McpResources,
  type McpPrompts,
} from "./capabilities.js";
export { mcpLateResultInformationKind } from "./late-result.js";
