/**
 * 功能概述：为 Planner 与 Composer 生成本轮可见证据的冷启动状态，不推断数据库是否为空。
 * 主要职责：contextBootstrapVariable 从冻结 turn、实际展示的历史和记忆生成结构化 Prompt 变量；
 * 按输入索引区分参与者的身份解析状态和可见历史，账号已建档不等同于熟人。
 * 代码库关系：两个 Prompt 编译器在选取及裁剪上下文后调用；行为措辞由各自 default/local 模板控制。
 * 输入输出与副作用：只读已授权原子；进一步限制历史到相同目标和冻结截止点，排除本轮输入；
 * 返回 context_bootstrap 及其来源 ID，不访问数据库、不补造人物关系、不触发发言或写入记忆。
 */
import type {
  DeepReadonly,
  InformationAtom,
  PromptVariable,
  z,
} from "@kaguya/schema";
import {
  assistantTextInformationKind,
  inboundTextInformationKind,
  turnContextCompletedInformationKind,
} from "./information-kinds.js";
import {
  beforeQuoteCutoff,
  sameMessageTarget,
} from "./message-composer/message-quote.js";

// turn 公共 schema 当前擦除了推导类型；这里仅为其已验证字段保留最小只读视图。
type Source = z.infer<
  typeof inboundTextInformationKind.payloadSchema
>["source"];
interface BootstrapTurn {
  readonly asOf: string;
  readonly source: Source;
  readonly inputs: readonly {
    readonly informationId: string;
    readonly source: Source;
    readonly identity: { readonly status: string; readonly scopeMode: string };
  }[];
}

export function contextBootstrapVariable(
  turn: DeepReadonly<InformationAtom>,
  histories: readonly DeepReadonly<InformationAtom>[],
  memories: readonly DeepReadonly<InformationAtom>[],
): PromptVariable {
  const payload = turnContextCompletedInformationKind.payloadSchema.parse(
    turn.payload,
  ) as unknown as BootstrapTurn;
  const inputIds = new Set(payload.inputs.map((input) => input.informationId));
  const history = histories.filter(
    (atom) =>
      !inputIds.has(atom.informationId) &&
      beforeQuoteCutoff(atom, payload.asOf) &&
      sameMessageTarget(atom.payload.source, payload.source) &&
      (atom.kind === inboundTextInformationKind.kind ||
        atom.kind === assistantTextInformationKind.kind),
  );
  const participants = payload.inputs.map((input, inputIndex) => ({
    inputIndex,
    identityStatus: input.identity.status,
    scopeMode: input.identity.scopeMode,
    priorInboundCount: history.filter((atom) => {
      if (atom.kind !== inboundTextInformationKind.kind) return false;
      const previous = inboundTextInformationKind.payloadSchema.parse(
        atom.payload,
      );
      return previous.source.senderId === input.source.senderId;
    }).length,
  }));
  return {
    name: "context_bootstrap",
    content: JSON.stringify({
      mode:
        history.length === 0 && memories.length === 0
          ? "bootstrap"
          : "contextual",
      scope: payload.source.destination.kind,
      historyCount: history.length,
      memoryCount: memories.length,
      participants,
    }),
    informationIds: [
      ...new Set([
        turn.informationId,
        ...history.map((atom) => atom.informationId),
        ...memories.map((atom) => atom.informationId),
      ]),
    ],
  };
}
