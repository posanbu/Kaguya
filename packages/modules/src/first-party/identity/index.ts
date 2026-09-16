/**
 * 功能概述：把正规化入站消息解析为聊天范围、平台账号与人物实体，并为每条入站提交唯一身份终态。
 * 主要职责：使用 Core registerOnce/commitTerminal 的原子槽位保证并发、重放和重启幂等；Web 匿名请求只产生
 * ephemeral 范围，不创建长期人物。代码库关系：消费 inbound kind，不读取 raw，也不依赖数据库查询投影。
 * 展示契约：Manifest 直接提供中文名称、摘要及输入输出职责，供 Inspection 与 WebUI 展示。
 * inspection 声明本模块的只读机制、领域数据和历史视图，由 Host/Server 投影给开发者控制台。
 */
import { firstPartyInspection } from "../inspection.js";
import { defineInformationModule, onInformation } from "@kaguya/sdk";
import { z } from "@kaguya/schema";
import {
  inboundTextInformationKind,
  chatScopeEntityInformationKind,
  chatScopeBindingInformationKind,
  platformAccountEntityInformationKind,
  platformAccountBindingInformationKind,
  personEntityInformationKind,
  personObservedInformationKind,
  personResolutionInformationKind,
  personContextCompletedInformationKind,
} from "../information-kinds.js";

const settingsSchema = z.object({}).strict();
const key = (value: unknown) => JSON.stringify(value);

export const identityModule = defineInformationModule({
  manifest: {
    protocolVersion: 1,
    moduleVersion: "1.0.0",
    definitionId: "core.identity.normalize",
    inspection: firstPartyInspection["core.identity.normalize"],
    displayName: "身份归一",
    summary: "将入站平台账号与会话解析为可追溯的稳定身份。",
    description:
      "消费入站消息，建立会话、账号和人物实体及绑定，输出身份上下文终态供回合屏障和记忆写回使用；保留未解析与降级状态，不负责鉴权或回复决策。",
    settingsSchema,
    consumes: [inboundTextInformationKind],
    produces: [
      chatScopeEntityInformationKind,
      chatScopeBindingInformationKind,
      platformAccountEntityInformationKind,
      platformAccountBindingInformationKind,
      personEntityInformationKind,
      personObservedInformationKind,
      personResolutionInformationKind,
      personContextCompletedInformationKind,
    ],
    selectors: [],
    promptRenderers: [],
    requires: [],
    provides: [],
  },
  create: () => ({
    provisions: [],
    describeStartup: () => ({
      summary: "Identity normalization ready",
      fields: { canonicalIdentity: true, webScopeMode: "ephemeral" },
    }),
    subscriptions: [
      onInformation(
        inboundTextInformationKind,
        { subscriptionId: "core.identity.inbound", delivery: "durable" },
        async (atom, context) => {
          const source = atom.payload as any;
          const s = source.source;
          const scopeMode = s.platform === "web" ? "ephemeral" : "canonical";
          const scope = await context.registerOnce(
            "core.identity.scope",
            scopeMode === "ephemeral"
              ? atom.informationId
              : key([s.platform, s.adapterId, s.destination]),
            chatScopeEntityInformationKind as any,
            {
              payload: {
                platform: s.platform,
                adapterId: s.adapterId,
                destination: s.destination,
                scopeMode,
              },
            } as any,
          );
          await context.registerOnce(
            "core.identity.scope.binding",
            scope.informationId,
            chatScopeBindingInformationKind,
            {
              payload: {
                platform: s.platform,
                adapterId: s.adapterId,
                destination: s.destination,
              },
              references: [
                { relation: "core:binds", informationId: scope.informationId },
              ],
            },
          );

          let accountInformationId: string | undefined;
          let personInformationId: string | undefined;
          if (scopeMode === "canonical" && s.senderId) {
            const account = await context.registerOnce(
              "core.identity.account",
              key([s.platform, s.adapterId, s.senderId]),
              platformAccountEntityInformationKind,
              {
                payload: {
                  platform: s.platform,
                  adapterId: s.adapterId,
                  accountId: s.senderId,
                },
              },
            );
            accountInformationId = account.informationId;
            const person = await context.registerOnce(
              "core.identity.person",
              key([s.platform, s.adapterId, s.senderId]),
              personEntityInformationKind,
              { payload: { accountId: s.senderId } },
            );
            personInformationId = person.informationId;
            await context.registerOnce(
              "core.identity.account.binding",
              account.informationId,
              platformAccountBindingInformationKind,
              {
                payload: {
                  accountId: s.senderId,
                  personInformationId: person.informationId,
                },
                references: [
                  {
                    relation: "core:binds",
                    informationId: account.informationId,
                  },
                ],
              },
            );
            const sender = s.sender;
            if (sender?.nickname || sender?.card) {
              await context.registerOnce(
                "core.identity.person.observed",
                atom.informationId,
                personObservedInformationKind,
                {
                  payload: {
                    accountId: s.senderId,
                    ...(sender.nickname ? { nickname: sender.nickname } : {}),
                    ...(sender.card ? { card: sender.card } : {}),
                    observedAt: atom.occurredAt,
                  },
                  references: [
                    {
                      relation: "core:observes",
                      informationId: account.informationId,
                    },
                  ],
                },
              );
            }
          }
          const status: "complete" | "unresolved" =
            scopeMode === "ephemeral" ? "unresolved" : "complete";
          const terminalPayload = {
            status,
            scopeMode,
            platform: s.platform,
            adapterId: s.adapterId,
            scopeInformationId: scope.informationId,
            ...(accountInformationId ? { accountInformationId } : {}),
            ...(personInformationId ? { personInformationId } : {}),
          } as const;
          await context.registerOnce(
            "core.identity.resolution",
            atom.informationId,
            personResolutionInformationKind,
            { payload: terminalPayload },
          );
          await context.commitTerminal(
            "core.identity.context",
            atom.informationId,
            personContextCompletedInformationKind,
            {
              payload: terminalPayload,
              references: [
                {
                  relation: "core:status-of",
                  informationId: atom.informationId,
                },
              ],
            },
          );
        },
      ),
    ],
  }),
});
