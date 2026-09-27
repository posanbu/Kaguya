/** 手动人物画像版本是独立的不可变事实；来源类型为未来 Memory 提取预留。 */
import {
  PERSON_PROFILE_REVISION_KIND,
  personProfileRevisionPayloadSchema,
} from "@kaguya/schema";
import { defineInformationKind } from "@kaguya/sdk";
import { personEntityInformationKind } from "./identity.js";

export const personProfileRevisionInformationKind = defineInformationKind({
  kind: PERSON_PROFILE_REVISION_KIND,
  displayName: "人物画像版本",
  description:
    "管理端手动维护的人物画像快照；运行时只使用服务启动时已生效的版本。",
  payloadSchema: personProfileRevisionPayloadSchema as any,
  references: {
    "memory:profile-of": {
      required: true,
      multiple: false,
      targetKinds: [personEntityInformationKind.kind],
    },
    "memory:previous-profile": {
      required: false,
      multiple: false,
      targetKinds: [PERSON_PROFILE_REVISION_KIND],
    },
  },
  log: {
    enabled: true,
    level: "info",
    project: ({ payload }) => ({
      event: "memory.identity.person.profile.revision",
      revision: Number(payload.revision),
    }),
  },
});
