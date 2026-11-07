/**
 * 功能概述：向模块提供按需资源读取和已选择 prompt 展开的受限能力 token。
 * resources 只读远端内容；prompts 不提供 selectPrompt，因此模型工具不能制造用户选择。
 * Server 注入 McpHost 的绑定方法；每次访问仍核对连接、scope 与本地白名单。
 * 此处只声明接口，不读取配置、不建立连接，也不改变远端返回内容的授权级别。
 */
import { defineModuleCapability } from "@kaguya/sdk";
import type { McpEnvelope } from "./connection.js";
import type { McpPromptSelection } from "./host.js";
export interface McpResources {
  list(connectionId: string, scope: string): Promise<McpEnvelope>;
  templates(connectionId: string, scope: string): Promise<McpEnvelope>;
  read(connectionId: string, scope: string, uri: string): Promise<McpEnvelope>;
}
export interface McpPrompts {
  list(connectionId: string, scope: string): Promise<McpEnvelope>;
  get(selection: McpPromptSelection): Promise<McpEnvelope>;
}
export const mcpResourcesCapability = defineModuleCapability<McpResources>(
  "mcp:resources",
  1,
);
export const mcpPromptsCapability = defineModuleCapability<McpPrompts>(
  "mcp:prompts",
  1,
);
