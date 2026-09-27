/** Unfinished native Memory definition; it has no runtime work or legacy Kind declarations. */
import { z } from "@kaguya/schema";
import { defineInformationModule } from "@kaguya/sdk";

export const memoryNativeModule = defineInformationModule({
  manifest: {
    protocolVersion: 1,
    moduleVersion: "0.0.0",
    definitionId: "memory.native",
    tags: ["memory"],
    displayName: "自研记忆",
    summary: "未完成：联想与索引的统一模块。",
    description: "联想、索引与检索仍在规划中；没有运行实例、订阅或后台任务。",
    development: {
      status: "incomplete",
      issueUrl: "https://github.com/posanbu/Kaguya/issues/265",
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
