/** Unfinished Mem0 Memory definition; it has no runtime work or legacy Kind declarations. */
import { z } from "@kaguya/schema";
import { defineInformationModule } from "@kaguya/sdk";

export const memoryMem0Module = defineInformationModule({
  manifest: {
    protocolVersion: 1,
    moduleVersion: "0.0.0",
    definitionId: "memory.mem0",
    tags: ["memory"],
    displayName: "Mem0 记忆",
    summary: "未完成：基于 Mem0 的认知记忆模块。",
    description:
      "Mem0 处理与快照检索仍在规划中；没有运行实例、订阅或后台任务。",
    development: {
      status: "incomplete",
      issueUrl: "https://github.com/posanbu/Kaguya/issues/266",
    },
    settingsSchema: z.object({}).strict(),
    consumes: [],
    produces: [],
    selectors: [],
    promptRenderers: [],
    requires: [],
    provides: [],
  },
  create: () => ({ provisions: [], subscriptions: [] }),
});
