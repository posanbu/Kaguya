import {
  compiledPromptSchema,
  nativeMemorySnapshotSchema,
  type NativeMemorySnapshot,
} from "@kaguya/schema";

export interface SituationRequestContext {
  memory?: NativeMemorySnapshot | null;
  memoryError?: string;
  recallRaw?: string | null;
  identityRaw: string | null;
  backgroundRaw: string | null;
  evidenceRaw: string | null;
  behavior: string | null;
  platform: string | null;
  background: {
    name: string;
    scope: string;
    participants: {
      name: string;
      label: string;
      relation: string;
      identityStatus: string;
      ownerId: string | null;
      raw: string;
    }[];
  } | null;
  targets: { name: string; kind: string; status: string }[];
  resolution: string | null;
  bootstrap: string | null;
  historyCount: number | null;
  attempt: number | null;
  waitBudget: number | null;
  canWait: boolean | null;
  backlog: {
    active: boolean;
    oldestMs: number | null;
    newestMs: number | null;
    thresholdMs: number | null;
  } | null;
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown) {
  return typeof value === "string" ? value : "";
}
function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}
function json(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    return object(JSON.parse(value));
  } catch {
    return {};
  }
}
/** Project the saved request. Never compile today's templates or infer missing state. */
export function situationRequestContext(
  payload: unknown,
): SituationRequestContext | null {
  const request = object(payload);
  const parsed = compiledPromptSchema.safeParse(request.prompt);
  if (!parsed.success) return null;
  const prompt = parsed.data;
  const values = new Map(
    prompt.variables.map((value) => [value.name, value.content]),
  );
  const conversation = json(values.get("conversation"));
  const background = object(
    conversation.background ?? json(values.get("conversation_background")),
  );
  const resolution = object(conversation.resolution);
  const sourceState = json(values.get("context_bootstrap"));
  const decision = json(values.get("decision_state"));
  const backlog = object(decision.backlog);
  let behavior = values.get("behavior_policy") ?? null;
  if (behavior === null && request.taskId === "agent.light.decide") {
    const time = values.get("current_time");
    const boundary = time ? prompt.text.indexOf(time) : -1;
    if (boundary > 0)
      behavior =
        prompt.text
          .slice(0, boundary)
          .replace(/当前时间[：:]\s*$/u, "")
          .trim() || null;
  }
  const memory = nativeMemorySnapshotSchema.safeParse(
    json(values.get("native_memory")),
  );
  return {
    memory: memory.success ? memory.data : null,
    recallRaw: values.get("memory_recall") ?? null,
    ...(values.has("native_memory") && !memory.success
      ? { memoryError: "此请求的记忆快照无法解析。" }
      : {}),
    identityRaw: values.get("identity") ?? values.get("persona") ?? null,
    backgroundRaw:
      values.get("conversation") ??
      values.get("conversation_background") ??
      null,
    evidenceRaw: values.get("context_bootstrap") ?? null,
    behavior,
    platform:
      values.get("platform_policy") ?? values.get("platform_style") ?? null,
    background:
      typeof background.name === "string"
        ? {
            name: background.name,
            scope: text(background.scope),
            participants: Array.isArray(background.participants)
              ? background.participants.map(object).map((person) => ({
                  name: text(person.name),
                  label: text(person.label),
                  relation: text(person.relation),
                  identityStatus: text(person.identityStatus),
                  ownerId:
                    typeof person.ownerId === "string" ? person.ownerId : null,
                  raw: JSON.stringify(person, null, 2),
                }))
              : [],
          }
        : null,
    targets: Array.isArray(resolution.targets)
      ? resolution.targets.map(object).map((target) => ({
          name: text(target.name),
          kind: text(target.kind),
          status: text(target.status),
        }))
      : [],
    resolution:
      typeof resolution.status === "string" ? resolution.status : null,
    bootstrap: text(sourceState.mode) || null,
    historyCount: number(sourceState.historyCount),
    attempt: number(decision.attempt),
    waitBudget: number(decision.totalWaitBudget),
    canWait: Array.isArray(decision.availableActions)
      ? decision.availableActions.includes("wait")
      : null,
    backlog:
      typeof backlog.isBacklog === "boolean"
        ? {
            active: backlog.isBacklog,
            oldestMs: number(backlog.oldestInputAgeMs),
            newestMs: number(backlog.newestInputAgeMs),
            thresholdMs: number(backlog.thresholdMs),
          }
        : null,
  };
}
export function situationAge(milliseconds: number | null): string {
  if (milliseconds === null) return "未记录";
  if (milliseconds < 60_000) return `${Math.ceil(milliseconds / 1000)}秒`;
  if (milliseconds < 3_600_000) return `${Math.ceil(milliseconds / 60_000)}分`;
  return `${Math.ceil(milliseconds / 3_600_000)}小时`;
}
