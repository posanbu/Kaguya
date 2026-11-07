/**
 * 功能概述：以真实 stdio MCP 目录和 Linux 原生注册验证组合装配，保留 Memory 路由与双方 providers。
 * fixture 在启动前登记关闭及临时目录清理，真实服务不调用模型或生产 broker；测试跨平台。
 * 代码库关系：消费 withServerMcp、mergeLinuxTools 和 McpHost；Linux 执行另由 shell Linux smoke 验收。
 */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { McpHost, mcpConfigurationSchema } from "@kaguya/mcp";
import { syntheticServerSource } from "@kaguya/mcp/testing";
import { LinuxToolsHost } from "@kaguya/runtime";
import { mergeLinuxTools, openLinuxTools } from "./linux-tools-host.js";
import { withServerMcp } from "./mcp-host.js";

it("combines actual MCP discovery with Linux and existing Memory without overwriting providers", async () => {
  const root = await mkdtemp(join(tmpdir(), "kg-combined-"));
  let mcp: McpHost | undefined;
  const linux = new LinuxToolsHost({
    version: 1,
    revision: "one",
    bindings: [{ scope: "scope", environmentId: "env", workflowId: "flow" }],
  });
  try {
    const script = join(root, "server.mjs"),
      state = join(root, "state.json"),
      journal = join(root, "journal.jsonl");
    await writeFile(script, syntheticServerSource);
    await writeFile(state, JSON.stringify({ protocol: "2025-11-25" }));
    await writeFile(journal, "");
    mcp = await McpHost.open(
      mcpConfigurationSchema.parse({
        version: 1,
        connections: [
          {
            id: "fixture",
            revision: "one",
            enabled: true,
            protocol: "2025-11-25",
            transport: {
              type: "stdio",
              command: process.execPath,
              args: [script, "stdio", state, journal],
            },
            scopes: ["scope"],
            tools: [{ name: "echo" }],
          },
        ],
      }),
      () => undefined,
      { ownershipDirectory: join(root, "processes") },
    );
    const existing = { id: "core.native-memory", version: "1" } as any;
    const combined = mergeLinuxTools(
      linux,
      withServerMcp(mcp, {
        actionProviders: [existing],
        nativeTools: {
          registrations: [],
          tasks: [
            {
              definitionId: "agent.heavy",
              taskId: "agent.heavy.respond",
              toolIds: ["memory.read"],
            },
          ],
        },
      }),
    );
    expect(combined.actionProviders!.map((p) => p.id)).toEqual([
      "core.native-memory",
      "mcp.fixture",
      "linux.environment",
    ]);
    expect(combined.nativeTools!.registrations.map((t) => t.id)).toEqual([
      "mcp.fixture.echo",
      "shell.exec",
    ]);
    expect(combined.nativeTools!.tasks[0]!.toolIds).toEqual([
      "memory.read",
      "mcp.fixture.echo",
      "shell.exec",
    ]);
    expect(combined.actionEnvironment).toBe(linux.snapshot().actionEnvironment);
    expect(await openLinuxTools(root)).toBeUndefined();
  } finally {
    try {
      await linux.close();
    } finally {
      try {
        await mcp?.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
});
