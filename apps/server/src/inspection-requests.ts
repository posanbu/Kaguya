/**
 * 功能概述：将持久化模型请求投影为逐次请求目录及独立详情，区分模型终态、业务决定与平台投递。
 * 主要职责：requestPage 按模块归属及 taskId 有界分页；requestDetail 从冻结输入和明确引用读取结果、原始 Prompt 与来源链。
 * 代码库关系：inspection.ts 校验 Manifest、认证和游标后调用本模块，并统一脱敏；此处只依赖数据库只读端口与 Schema DTO。
 * 输入输出与副作用：不执行模型、不重新编译 Prompt、不按现存 bindings 丢弃历史；每页最多扫描 501 条，输入/引用各最多 100 条。
 * 详情保留完整 Prompt 与正文；源链缺失明确返回 contextAvailable=false，未出现投递终态不能推断发送成功。
 */
import type { InformationRepository } from "@kaguya/database";
import { isDeepStrictEqual } from "node:util";
import type {
  DeepReadonly,
  InformationAtom,
  InspectionRequestDetail,
  InspectionRequestSummary,
  ModuleInspectionSurfaceV1,
  JsonValue,
} from "@kaguya/schema";

export type RequestBrowser = Extract<
  ModuleInspectionSurfaceV1["components"][number],
  { type: "model-request-browser" }
>;
type Ledger = Pick<InformationRepository, "get" | "inspectPage">;
type Atom = DeepReadonly<InformationAtom>;
type Cursor = { occurredAt: string; informationId: string };
const requestedKind = "core.model.task.requested";
const terminalKinds = [
  "core.model.task.completed",
  "core.model.task.failed",
  "core.model.task.cancelled",
];
const maxItems = 100;

function field(value: unknown, path: string): unknown {
  for (const key of path.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
      return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
const string = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const textAt = (value: unknown, path: string) => string(field(value, path));
const references = (atom: Atom, relation: string, id: string) =>
  atom.references.some(
    (r) => r.relation === relation && r.informationId === id,
  );
const uniqueReference = (
  atom: Atom,
  relation: string,
  id: string | undefined,
) =>
  Boolean(
    id &&
    atom.references.filter((r) => r.relation === relation).length === 1 &&
    references(atom, relation, id),
  );

export function matchesRequest(
  atom: Atom,
  definitionId: string,
  browser: RequestBrowser,
) {
  return (
    atom.kind === requestedKind &&
    field(atom.payload, "taskId") === browser.taskId &&
    field(atom.payload, "activation.definitionId") === definitionId
  );
}

/** SQL 先隔离历史模块归属，再精确筛选任务；游标只越过实际消费过的行，不跳过未展示的匹配项。 */
export async function requestPage(
  ledger: Ledger,
  definitionId: string,
  browser: RequestBrowser,
  limit: number,
  cursor?: Cursor,
) {
  const rows = await ledger.inspectPage({
    kind: requestedKind,
    payloadIn: { path: ["activation", "definitionId"], values: [definitionId] },
    limit: 501,
    ...(cursor ? { cursor } : {}),
  });
  const selected: Atom[] = [];
  let last: Atom | undefined;
  let hasMore = rows.length === 501;
  for (const atom of rows) {
    if (matchesRequest(atom, definitionId, browser)) {
      if (selected.length === limit) {
        hasMore = true;
        break;
      }
      selected.push(atom);
    }
    last = atom;
  }
  const items: InspectionRequestSummary[] = [];
  for (const atom of selected)
    items.push((await projectRequest(ledger, browser, atom, false)).request);
  return {
    items,
    cursor:
      hasMore && last
        ? { occurredAt: last.occurredAt, informationId: last.informationId }
        : null,
  };
}

export async function requestDetail(
  ledger: Ledger,
  browser: RequestBrowser,
  request: Atom,
) {
  return projectRequest(ledger, browser, request, true);
}

async function projectRequest(
  ledger: Ledger,
  browser: RequestBrowser,
  request: Atom,
  detail: boolean,
): Promise<Omit<InspectionRequestDetail, "version" | "surfaceId">> {
  let truncated = false;
  const trace: InspectionRequestDetail["trace"] = [];
  const add = (atom: Atom | undefined, label: string, status?: string) => {
    if (
      !atom ||
      !detail ||
      trace.some((item) => item.informationId === atom.informationId)
    )
      return;
    if (trace.length >= maxItems) {
      truncated = true;
      return;
    }
    trace.push({
      informationId: atom.informationId,
      kind: atom.kind,
      occurredAt: atom.occurredAt,
      label,
      ...(status ? { status } : {}),
    });
  };
  const reverse = async (
    atom: Atom,
    relation: string,
    kinds: string[],
    limit = 20,
  ) => {
    const rows = await ledger.inspectPage({
      referencedId: atom.informationId,
      relation,
      kinds,
      limit: limit + 1,
    });
    if (rows.length > limit) truncated = true;
    return rows.slice(0, limit);
  };
  const sourceId = textAt(request.payload, "sourceInformationId");
  const runtimeContextId = textAt(request.payload, "contextInformationId");
  const source =
    sourceId &&
    uniqueReference(request, "core:caused-by", sourceId) &&
    uniqueReference(request, "core:context", runtimeContextId)
      ? await ledger.get(sourceId)
      : undefined;
  const expectedSource =
    browser.mode === "planner"
      ? "agent.attention.arousal.completed"
      : "agent.message.intent.requested";
  const validSource =
    source?.kind === expectedSource &&
    uniqueReference(source, "core:context", runtimeContextId)
      ? source
      : undefined;
  const turnId = validSource
    ? textAt(
        validSource.payload,
        browser.mode === "planner"
          ? "turnContextInformationId"
          : "turn.contextInformationId",
      )
    : undefined;
  const turnCandidate =
    turnId &&
    validSource &&
    references(validSource, "core:uses-context", turnId)
      ? await ledger.get(turnId)
      : undefined;
  const sourceTurn =
    browser.mode === "planner"
      ? validSource?.payload
      : field(validSource?.payload, "turn");
  const turn =
    turnCandidate?.kind === "agent.turn.context.completed" &&
    ["candidateInformationId", "claimInformationId"].every(
      (key) => field(sourceTurn, key) === field(turnCandidate.payload, key),
    )
      ? turnCandidate
      : undefined;
  const authorizationId =
    browser.mode === "composer"
      ? validSource?.references.find(
          (r) => r.relation === "agent:target-authorization",
        )?.informationId
      : undefined;
  const authorizationCandidate =
    authorizationId &&
    validSource &&
    uniqueReference(
      validSource,
      "agent:target-authorization",
      authorizationId,
    ) &&
    references(validSource, "core:uses-context", authorizationId)
      ? await ledger.get(authorizationId)
      : undefined;
  const authorization =
    authorizationCandidate?.kind === "agent.message.target.authorized" &&
    uniqueReference(authorizationCandidate, "core:context", runtimeContextId) &&
    sameTarget(
      field(authorizationCandidate.payload, "target"),
      field(validSource?.payload, "target"),
    ) &&
    (turnId === authorizationCandidate.informationId ||
      isDeepStrictEqual(
        field(authorizationCandidate.payload, "turn"),
        sourceTurn,
      ))
      ? authorizationCandidate
      : undefined;
  const rawInputs = turn ? field(turn.payload, "inputs") : undefined;
  const inputs: InspectionRequestDetail["inputs"] = [];
  if (Array.isArray(rawInputs)) {
    if (rawInputs.length > maxItems) truncated = true;
    for (const input of rawInputs.slice(-maxItems)) {
      const informationId = textAt(input, "informationId");
      const text = textAt(input, "text");
      if (!informationId || text === undefined) continue;
      const occurredAt = textAt(input, "occurredAt");
      const sender =
        textAt(input, "source.sender.card") ??
        textAt(input, "source.sender.nickname") ??
        textAt(input, "source.senderId");
      inputs.push({
        informationId,
        text,
        ...(occurredAt ? { occurredAt } : {}),
        ...(sender ? { sender } : {}),
      });
    }
  }
  const instruction = authorization
    ? textAt(authorization.payload, "instruction")
    : undefined;
  if (authorization && instruction !== undefined) {
    inputs.splice(0, inputs.length, {
      informationId: authorization.informationId,
      occurredAt: authorization.occurredAt,
      sender: "授权发送要求",
      text: instruction,
    });
  }
  add(turn, "冻结的入站上下文");
  add(validSource, browser.mode === "planner" ? "注意力评估" : "消息生成意图");
  add(authorization, "跨会话授权指令");
  add(request, "模型请求", "requested");
  const terminals = await reverse(request, "core:status-of", terminalKinds);
  // 终态必须同时满足因果边及同一任务归属，不能通过共享 runtime context 拼接别的请求。
  const terminal = terminals.find(
    (atom) =>
      uniqueReference(atom, "core:caused-by", request.informationId) &&
      uniqueReference(atom, "core:status-of", request.informationId) &&
      uniqueReference(atom, "core:context", runtimeContextId) &&
      [
        "taskId",
        "version",
        "sourceInformationId",
        "contextInformationId",
        "activation.definitionId",
        "activation.instanceId",
      ].every(
        (key) => field(atom.payload, key) === field(request.payload, key),
      ),
  );
  let status = terminal
    ? terminal.kind.slice("core.model.task.".length)
    : "pending";
  add(
    terminal,
    (
      {
        completed: "模型生成完成",
        failed: "模型请求失败",
        cancelled: "模型请求取消",
      } as Record<string, string>
    )[status] ?? "模型终态",
    status,
  );
  const result: InspectionRequestDetail["result"] = {};
  let adoptedPlan: Atom | undefined;
  let outcomeText =
    (
      {
        pending: "尚未记录结果",
        completed: "模型已完成，尚无业务结果",
        failed: "请求失败",
        cancelled: "已取消",
      } as Record<string, string>
    )[status] ?? "尚无结果";
  if (status === "failed")
    result.reason =
      textAt(terminal!.payload, "error.message") ??
      textAt(terminal!.payload, "error.kind") ??
      "模型请求失败";
  if (status === "cancelled")
    result.reason = textAt(terminal!.payload, "reason") ?? "模型请求已取消";
  if (browser.mode === "planner") {
    const plans = terminal
      ? await reverse(terminal, "core:uses-context", [
          "agent.turn.plan.completed",
        ])
      : [];
    const plan = plans.find(
      (atom) =>
        validSource &&
        field(atom.payload, "gateInformationId") ===
          validSource.informationId &&
        uniqueReference(atom, "core:caused-by", validSource.informationId) &&
        uniqueReference(
          atom,
          "core:status-of",
          textAt(validSource.payload, "claimInformationId"),
        ),
    );
    if (plan) {
      adoptedPlan = plan;
      result.action = textAt(plan.payload, "action.action");
      result.reason = textAt(plan.payload, "action.reason");
      const seconds = field(plan.payload, "action.waitSeconds");
      outcomeText =
        result.action === "message"
          ? "回复消息"
          : result.action === "wait"
            ? `等待${typeof seconds === "number" ? ` ${seconds} 秒` : "更多上下文"}`
            : result.action === "silent"
              ? "保持静默"
              : "已记录规划结果";
      const topic = textAt(plan.payload, "action.composition.topic");
      const replyAct = textAt(plan.payload, "action.composition.replyAct");
      const guidance = textAt(plan.payload, "action.composition.guidance");
      result.text =
        [topic, replyAct, guidance].filter(Boolean).join("\n") || outcomeText;
      add(plan, "实际规划决定", result.action);
      if (detail && result.action === "message" && validSource && turn) {
        const linked = [
          ...(await reverse(validSource, "core:caused-by", [
            "agent.message.intent.requested",
          ])),
          ...(await reverse(plan, "core:caused-by", [
            "agent.message.intent.requested",
          ])),
        ];
        const intents = [
          ...new Map(linked.map((atom) => [atom.informationId, atom])).values(),
        ].filter(
          (atom) =>
            field(atom.payload, "turn.contextInformationId") ===
              turn.informationId &&
            ["candidateInformationId", "claimInformationId"].every(
              (key) =>
                field(atom.payload, `turn.${key}`) === field(turn.payload, key),
            ),
        );
        let followed = 0;
        for (const intent of intents) {
          if (followed >= 10 || trace.length >= maxItems) {
            truncated = true;
            break;
          }
          add(intent, "下游消息生成意图");
          const requests = (
            await reverse(intent, "core:caused-by", [requestedKind])
          ).filter(
            (atom) =>
              field(atom.payload, "taskId") === "agent.message.compose" &&
              field(atom.payload, "sourceInformationId") ===
                intent.informationId,
          );
          for (const downstream of requests) {
            if (followed >= 10 || trace.length >= maxItems) {
              truncated = true;
              break;
            }
            followed++;
            const projection = await projectRequest(
              ledger,
              { ...browser, taskId: "agent.message.compose", mode: "composer" },
              downstream,
              true,
            );
            truncated ||= projection.truncated;
            for (const item of projection.trace) {
              if (
                trace.some(
                  (known) => known.informationId === item.informationId,
                )
              )
                continue;
              if (trace.length >= maxItems) {
                truncated = true;
                break;
              }
              trace.push(item);
            }
          }
        }
      }
    } else if (turn) {
      const claimId = textAt(turn.payload, "claimInformationId");
      if (claimId) {
        const interrupted = await ledger.inspectPage({
          referencedId: claimId,
          relation: "core:status-of",
          kinds: [
            "agent.turn.decision.interrupted",
            "agent.turn.decision.superseded",
          ],
          limit: 2,
        });
        if (interrupted.length > 1) truncated = true;
        if (interrupted[0]) {
          status = "interrupted";
          outcomeText = interrupted[0].kind.endsWith("superseded")
            ? "已被更新回合替代"
            : "被新消息打断";
          result.reason = outcomeText;
          add(interrupted[0], outcomeText, "interrupted");
        }
      }
    }
  } else if (terminal?.kind === "core.model.task.completed") {
    const assistants = await reverse(terminal, "core:caused-by", [
      "core.message.assistant.text",
    ]);
    const assistant = assistants.find(
      (atom) =>
        validSource &&
        field(atom.payload, "originatingModuleInstanceId") ===
          field(request.payload, "activation.instanceId") &&
        isDeepStrictEqual(
          field(atom.payload, "turn"),
          field(validSource.payload, "turn"),
        ) &&
        sameTarget(
          field(atom.payload, "source"),
          field(validSource.payload, "target"),
        ),
    );
    const text = assistant
      ? textAt(assistant.payload, "text")
      : string(field(terminal.payload, "output"));
    if (text !== undefined) {
      result.text = text;
      outcomeText = assistant
        ? text || "已生成空正文"
        : "模型已返回，尚未记录最终消息";
      if (!assistant)
        result.reason = "以下为模型返回内容，尚无对应的最终消息记录。";
    }
    add(assistant, "生成正文", "generated");
    if (detail && assistant) {
      const confirmed = (
        await reverse(assistant, "core:caused-by", [
          "agent.message.content.confirmed",
        ])
      ).filter(
        (atom) =>
          field(atom.payload, "assistantInformationId") ===
          assistant.informationId,
      );
      for (const confirmation of confirmed)
        add(confirmation, "正文已确认", "confirmed");
      for (const origin of [assistant, ...confirmed]) {
        if (trace.length >= maxItems) {
          truncated = true;
          break;
        }
        const deliveries = (
          await reverse(origin, "core:caused-by", ["core.delivery.requested"])
        ).filter(
          (atom) =>
            isDeepStrictEqual(
              field(atom.payload, "turn"),
              field(assistant.payload, "turn"),
            ) && sameTarget(atom.payload, field(assistant.payload, "source")),
        );
        for (const delivery of deliveries) {
          if (trace.length >= maxItems) {
            truncated = true;
            break;
          }
          add(delivery, "平台投递请求", "pending");
          const receipts = await reverse(delivery, "core:status-of", [
            "core.delivery.delivered",
            "core.delivery.failed",
          ]);
          const receipt = receipts.find(
            (atom) =>
              uniqueReference(atom, "core:caused-by", delivery.informationId) &&
              (atom.kind === "core.delivery.failed" ||
                field(atom.payload, "ok") === true) &&
              field(atom.payload, "adapterId") ===
                field(delivery.payload, "adapterId") &&
              field(atom.payload, "platform") ===
                field(delivery.payload, "platform") &&
              (atom.kind === "core.delivery.failed" ||
                isDeepStrictEqual(
                  field(atom.payload, "target"),
                  field(delivery.payload, "destination"),
                )),
          );
          add(
            receipt,
            receipt?.kind === "core.delivery.delivered"
              ? "平台已送达"
              : "平台投递失败",
            receipt?.kind === "core.delivery.delivered"
              ? "delivered"
              : "failed",
          );
        }
      }
    }
  }
  if (detail && (turn || authorization)) {
    const candidateId = textAt(sourceTurn, "candidateInformationId");
    const claimId = textAt(sourceTurn, "claimInformationId");
    if (candidateId && claimId) {
      const rows = await ledger.inspectPage({
        referencedId: candidateId,
        relation: "core:status-of",
        kinds: [
          "agent.turn.completed",
          "agent.turn.waiting",
          "agent.turn.silent",
          "agent.turn.failed",
          "agent.turn.superseded",
          "agent.turn.interrupted",
        ],
        limit: 21,
      });
      if (rows.length > 20) truncated = true;
      const terminal = rows
        .slice(0, 20)
        .find(
          (atom) =>
            field(atom.payload, "candidateInformationId") === candidateId &&
            field(atom.payload, "claimInformationId") === claimId &&
            uniqueReference(atom, "agent:turn-claim", claimId),
        );
      const terminalCause = terminal
        ? (textAt(terminal.payload, "deliveryTerminalInformationId") ??
          terminal.references.find((r) => r.relation === "core:caused-by")
            ?.informationId)
        : undefined;
      // 同一 intent/turn 可有不同指纹的模型请求。仅收录本次请求已经沿因果链验证过的终态，不能反向借用别次请求的投递。
      if (
        terminal &&
        terminalCause &&
        trace.some((item) => item.informationId === terminalCause) &&
        (browser.mode === "composer" || adoptedPlan)
      ) {
        const turnStatus = terminal.kind.slice("agent.turn.".length);
        const labels: Record<string, string> = {
          completed: "回合已完成",
          waiting: "回合等待下次检查",
          silent: "回合已静默结束",
          failed: "回合失败",
          superseded: "回合已被替代",
          interrupted: "回合已被打断",
        };
        add(terminal, labels[turnStatus] ?? "回合终态", turnStatus);
      }
    }
  }
  const prompt = textAt(request.payload, "prompt.text");
  const model: NonNullable<InspectionRequestDetail["model"]> = [];
  if (detail) {
    for (const [path, label] of [
      ["resolvedModel.providerId", "提供方"],
      ["resolvedModel.modelId", "模型"],
      ["selectionPolicy.tier", "模型层级"],
      ["activation.instanceId", "来源实例"],
      ["durationMs", "耗时（毫秒）"],
      ["usage", "模型用量"],
      ["error", "模型请求错误"],
    ]) {
      const value =
        field(terminal?.payload, path!) ?? field(request.payload, path!);
      if (value !== undefined)
        model.push({ label: label!, value: value as JsonValue });
    }
  }
  return {
    request: {
      requestId: request.informationId,
      occurredAt: request.occurredAt,
      status,
      triggerText: inputs.length
        ? (authorization
            ? "授权发送要求："
            : inputs.at(-1)!.sender
              ? inputs.at(-1)!.sender + "："
              : "") + inputs.at(-1)!.text
        : "触发消息不可用",
      outcomeText,
      inputCount: authorization
        ? 1
        : Array.isArray(rawInputs)
          ? rawInputs.length
          : 0,
      triggerKind: authorization ? "authorization" : "inbound",
    },
    inputs,
    prompt:
      detail && prompt !== undefined
        ? { available: true, text: prompt }
        : { available: false },
    result,
    model,
    trace: trace.sort(
      (a, b) =>
        Date.parse(a.occurredAt) - Date.parse(b.occurredAt) ||
        a.informationId.localeCompare(b.informationId),
    ),
    truncated,
    contextAvailable: Boolean(
      (authorization && instruction !== undefined) ||
      (turn && Array.isArray(rawInputs)),
    ),
  };
}

function sameTarget(left: unknown, right: unknown) {
  return ["adapterId", "platform", "destination"].every((key) =>
    isDeepStrictEqual(field(left, key), field(right, key)),
  );
}
