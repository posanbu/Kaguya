/**
 * 功能概述：为事件与 Wiki 记忆提供宿主启动入口，只登记可恢复的回填和维护根任务。
 * 主要职责：createMemoryKnowledgeBootstrap 构造 requestBackfill/requestMaintenance 窄能力；
 * requestBackfill 先持久登记历史扫描，再登记脏页维护，requestMaintenance 为一次变更建立独立扫描。
 * 代码库关系：Runtime 注入 InformationCore 与时钟；memory-knowledge 模块消费根任务，
 * 每页通过持久游标推进，负责证据截止点、页面 CAS 和唯一终态。本文件不直接读取页面或原始正文。
 * 输入输出与副作用：每次调用仅登记有限个 Information atom，无定时器或无界循环；
 * 每次启动根任务拥有独立 Information 身份，后续页面以父请求身份幂等登记，登记失败交给宿主处理。
 */
import type { InformationCore } from "@kaguya/engine";
import {
  memoryKnowledgeBackfillInformationKind,
  memoryKnowledgeMaintenanceInformationKind,
} from "@kaguya/modules";

export function createMemoryKnowledgeBootstrap(options: {
  readonly core: Pick<InformationCore, "register">;
  readonly now: () => Date;
}) {
  async function requestMaintenance(): Promise<void> {
    await options.core.register(memoryKnowledgeMaintenanceInformationKind, {
      source: "runtime:memory-knowledge",
      occurredAt: options.now().toISOString(),
      payload: { after: null },
      references: [],
    });
  }

  async function requestBackfill(): Promise<void> {
    await options.core.register(memoryKnowledgeBackfillInformationKind, {
      source: "runtime:memory-knowledge",
      occurredAt: options.now().toISOString(),
      payload: { afterInformationId: null },
      references: [],
    });
    await requestMaintenance();
  }

  return Object.freeze({ requestBackfill, requestMaintenance });
}
