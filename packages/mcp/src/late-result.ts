/**
 * 功能概述：声明取消后仍被 transport 观察到的 MCP 原始响应事实，独立于 W3 行动终态。
 * mcpLateResultInformationKind 关联原 intent，保存同 scope 来源、请求配对和不可信响应。
 * Server 在启动前注册 Kind 并提供持久观察端口；该事实不确认执行成功、不重放、不授予权限。
 * 只有已发送 tools/call 的已知 JSON-RPC ID 可产生此记录，凭据先由连接边界脱敏。
 */
import { defineInformationKind } from "@kaguya/sdk";
import { z } from "@kaguya/schema";
export const mcpLateResultInformationKind = defineInformationKind({
  kind: "mcp.client.late-result.v1",
  displayName: "MCP 迟到响应",
  description: "保留取消后实际观察的远端响应；原行动终态保持不变。",
  payloadSchema: z
    .object({
      scopeKey: z.string(),
      responseDigest: z.string(),
      envelope: z.json(),
    })
    .strict(),
  references: { "core:caused-by": { required: true, multiple: false } },
  log: { enabled: false },
});
