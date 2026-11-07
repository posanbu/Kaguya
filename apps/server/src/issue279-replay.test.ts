/**
 * 功能概述：同一虚构多人场景贯穿正式 Server/Adapter/Identity/Memory/观察/行动/MCP/Inspection。
 * 每组在 PGlite 与显式 PG schema 上执行，模型仅替换 HTTP；来源/冻结/形成/结果均由生产 writer 创建。
 * 主要职责：quiet 检查独立形成；late 检查跨页旧冻结；holes 检查失败不越水位；withdraw 检查准入；
 * success 验证工具成功、Heavy 接续与一次投递；unknown 用独立 stdio journal 核对真实一次 effect。
 * SQL 只读定位身份，不能种成功事实或消费进度；门闩期间等待已登记形成请求，最终仍检查整个队列收敛。
 * 代码库关系：复用 test-support/replay-fixture、persistence 和 MCP 合成服务；不执行外部 LLM 或物理 GUI。
 * 迟到来源按冻结页逐页等待观察确认，再单独等待模型与持久队列收尾，避免将多页串行工作压进一个等待预算。
 * waitIngressFanout 按输入逐条证明 Lifecycle、身份推进和 Focus 的精确 ACK，避免空队列或批量时长误判。
 * waitObservedTurns 按唯一 turn 等待 Light、决策、observe/dispatch 和终态 progress ACK；分页释放后逐阶段收敛。
 * successor 先检查冻结观察，再绑定同一 turn 的 Light，并比较 native_memory 中的实际修订和来源正文。
 * waitForHeavyInput 先证明触发消息进入真实情境和 Light 终态；十页批量确认按每页 8 秒组成基础设施预算。
 * 所有 gate 在 fixture.close 释放，模型工作收敛后再关闭 Runtime/SQL；各阶段8秒、外层按顺序阶段计预算。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createReplayFixture,
  replayScenario,
  replayScope,
  replayBudget,
  replayCleanupBudget,
  type ReplayFixture,
} from "./test-support/replay-fixture.js";

const wire = vi.hoisted(() => ({
  fetch: undefined as typeof globalThis.fetch | undefined,
}));
vi.mock("@ai-sdk/openai-compatible", async (load) => {
  const actual = await load<typeof import("@ai-sdk/openai-compatible")>();
  return {
    ...actual,
    createOpenAICompatible: (options: any) =>
      actual.createOpenAICompatible({
        ...options,
        fetch: (...args: Parameters<typeof globalThis.fetch>) => {
          if (!wire.fetch)
            throw new Error("Replay HTTP boundary not installed");
          return wire.fetch(...args);
        },
      }),
  };
});
const resources: ReplayFixture[] = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const f of resources.splice(0).reverse())
    try {
      await f.close();
    } catch (e) {
      errors.push(e);
    }
  vi.restoreAllMocks();
  wire.fetch = undefined;
  if (errors.length)
    throw new AggregateError(errors, "Unified replay cleanup failed");
}, replayCleanupBudget);
const url = process.env.KAGUYA_TEST_DATABASE_URL?.trim();
if (process.env.KAGUYA_REQUIRE_POSTGRES_TESTS === "1" && !url)
  throw new Error("PostgreSQL replay URL required");
const backends = ["PGlite", ...(url ? ["PostgreSQL"] : [])] as Array<
  "PGlite" | "PostgreSQL"
>;
function gate(f: ReplayFixture) {
  const held = Promise.withResolvers<void>();
  f.gates.push(() => held.resolve());
  return held;
}
async function setup(backend: "PGlite" | "PostgreSQL") {
  const control = {
    speak: false,
    failBatch: "",
    failNextFormation: false,
    lightGate: undefined as Promise<void> | undefined,
    heavyCalls: 0,
  };
  const f = await createReplayFixture(
    backend,
    (fetch) => {
      wire.fetch = fetch;
    },
    async (body, fixture) => {
      const prompt = JSON.stringify(body.messages);
      const batchId = /"batchId"\s*:\s*"([^"\\]+)"/.exec(
        prompt.replaceAll('\\"', '"'),
      )?.[1];
      if (batchId) {
        const requested = (
          await fixture.facts("memory.native.formation.requested.v1")
        ).find((a) => a.payload.batchId === batchId);
        expect(requested).toBeDefined();
        const p = requested!.payload as any;
        if (control.failNextFormation) {
          control.failBatch = batchId;
          control.failNextFormation = false;
        }
        if (control.failBatch === batchId)
          return new Response("synthetic formation failure", { status: 400 });
        const existing = [
          ...p.existing.fixed,
          ...p.existing.recalled.map((r: any) => r.node),
        ].find((n: any) => n.metadata.kind === "experience");
        return {
          nodes: [
            {
              key: existing?.id ?? "activity",
              expressionType: null,
              kind: "experience",
              ownerId: `conversation:${p.scope}`,
              scope: p.scope,
              level: 1,
              content: [existing?.content, ...p.sources.map((s: any) => s.text)]
                .filter(Boolean)
                .join("；")
                .slice(-3500),
              sourceIds: [
                ...new Set([
                  ...(existing?.metadata.sourceIds ?? []),
                  ...p.sources.map((s: any) => s.id),
                ]),
              ],
              tags: ["虚构活动"],
              aliases: [],
              status: "active",
              experience: { state: "open", policyVersion: "experience.v1" },
            },
          ],
          edges: [],
        };
      }
      if (body.model === "light") {
        await control.lightGate;
        return control.speak
          ? { action: "message", reason: "respond" }
          : { action: "silent", reason: "no-response-needed" };
      }
      control.heavyCalls++;
      if (!body.messages.some((m: any) => m.role === "tool")) {
        const tool = body.tools?.find((t: any) =>
          t.function.description.includes("synthetic echo"),
        );
        expect(tool).toBeDefined();
        return {
          tool_calls: [
            {
              id: `weather-${control.heavyCalls}`,
              type: "function",
              function: { name: tool.function.name, arguments: '{"value":7}' },
            },
          ],
        };
      }
      return { action: "message", text: "已读取带来源的虚构天气结果" };
    },
  );
  resources.push(f);
  return { f, control };
}
async function prefix(
  f: ReplayFixture,
  group = "G",
  adapter = "replay.qq",
  offset = "prefix",
) {
  const sources: string[] = [];
  for (const [i, text] of replayScenario.prefix.entries()) {
    const receipt = await f.submit(
      f.message(
        `${offset}-${group}-${i}`,
        text,
        group,
        replayScenario.people[i % 3],
        adapter,
      ),
    );
    sources.push(receipt.inboundInformationId);
  }
  await waitIngressFanout(f, `${group}/${adapter}: prefix`, sources);
  await waitCanonicalSources(f, sources);
  expect(
    (await f.facts("memory.native.source.v1")).filter((a) =>
      sources.includes(String(a.payload.originalInformationId)),
    ),
  ).toHaveLength(8);
  let batchId = "";
  await f.wait(
    `${group}/${adapter}: source-bound formation requested`,
    async () => {
      const request = (
        await f.facts("memory.native.formation.requested.v1")
      ).find(
        (a) =>
          a.payload.scope === replayScope(group, adapter) &&
          (a.payload.sources as any[]).some((source) =>
            sources.includes(source.id),
          ),
      );
      expect(request).toBeDefined();
      batchId = String(request!.payload.batchId);
    },
  );
  await f.wait(`${group}/${adapter}: formation completed`, async () => {
    const done = (await f.facts("memory.native.formation.completed.v1")).filter(
      (a) => a.payload.batchId === batchId,
    );
    expect(done.some((a) => a.payload.status === "completed")).toBe(true);
  });
  await f.wait(`${group}/${adapter}: Memory observation ACK`, async () => {
    const canonical = await f.facts("memory.native.source.v1");
    const acks = await f.facts("memory.native.observation.completed.v1");
    expect(
      acks.some(
        (a) =>
          a.payload.operationId === batchId &&
          a.references.some((r) =>
            canonical.some(
              (c) =>
                c.informationId === r.informationId &&
                sources.includes(String(c.payload.originalInformationId)),
            ),
          ),
      ),
    ).toBe(true);
  });
  for (const sourceId of sources) {
    await f.wait(
      `${group}/${adapter}: turn context for ${sourceId}`,
      async () => {
        const inputs = new Set(
          (await f.facts("agent.router.turn.context.completed")).flatMap((a) =>
            (a.payload.inputs as any[]).map((input) => input.informationId),
          ),
        );
        expect(inputs.has(sourceId)).toBe(true);
      },
    );
    await f.wait(
      `${group}/${adapter}: Situation page for ${sourceId}`,
      async () => {
        const observed = new Set(
          (await rows(f))
            .filter((o) => o?.status === "completed")
            .flatMap((o) => [...o!.sourceInformationIds]),
        );
        expect(observed.has(sourceId)).toBe(true);
      },
    );
  }
  const inputs = new Set(
    (await f.facts("agent.router.turn.context.completed")).flatMap((a) =>
      (a.payload.inputs as any[]).map((input) => input.informationId),
    ),
  );
  const observed = new Set(
    (await rows(f))
      .filter((o) => o?.status === "completed")
      .flatMap((o) => [...o!.sourceInformationIds]),
  );
  expect(sources.every((id) => inputs.has(id) && observed.has(id))).toBe(true);
  await waitObservedTurns(f, sources);
  return sources;
}
type ReplayAtom = Awaited<ReturnType<ReplayFixture["facts"]>>[number];
async function waitAcknowledged(
  f: ReplayFixture,
  phase: string,
  subscription: string,
  informationId: string,
) {
  await f.wait(`${phase}: ${subscription} ACK ${informationId}`, async () => {
    const result = await f.db.sql.query<{ state: string }>(
      "SELECT state FROM information_deliveries WHERE subscription_id=$1 AND information_id=$2",
      [subscription, informationId],
    );
    expect(result.rows).toEqual([{ state: "acked" }]);
  });
}
async function hasTurnTerminal(f: ReplayFixture, turn: ReplayAtom) {
  const candidateId = String(turn.payload.candidateInformationId);
  const claimId = String(turn.payload.claimInformationId);
  const terminals = await f.db.information.query({
    informationId: candidateId,
    relation: "core:status-of",
  });
  return terminals.some(
    (atom) =>
      atom.payload.candidateInformationId === candidateId &&
      (atom.kind === "agent.attention.arousal.completed"
        ? atom.payload.outcome === "defer"
        : [
            "completed",
            "waiting",
            "silent",
            "failed",
            "superseded",
            "interrupted",
          ].some((status) => atom.kind === `agent.router.turn.${status}`) &&
          atom.payload.claimInformationId === claimId &&
          atom.references.some(
            (r) =>
              r.relation === "agent:turn-claim" && r.informationId === claimId,
          )),
  );
}
async function waitObservedTurns(f: ReplayFixture, sourceIds: string[]) {
  // 仅在 Light 门闩已释放时调用；每个持久 turn 只处理一次，不能按消息数量假定模型调用数。
  const turns = (await f.facts("agent.router.turn.context.completed")).filter(
    (turn) =>
      (turn.payload.inputs as any[]).some((input) =>
        sourceIds.includes(input.informationId),
      ),
  );
  for (const turn of new Map(
    turns.map((turn) => [turn.informationId, turn]),
  ).values()) {
    const phase = `observed turn ${turn.informationId}`;
    const request = await f.wait(
      `${phase}: Light requested or turn terminated`,
      async () => {
        const requests = (await f.facts("core.model.task.requested")).filter(
          (a) =>
            a.payload.taskId === "agent.light.decide" &&
            a.payload.sourceInformationId === turn.informationId,
        );
        if (requests.length) {
          expect(requests).toHaveLength(1);
          return requests[0];
        }
        expect(await hasTurnTerminal(f, turn)).toBe(true);
        return undefined;
      },
    );
    if (request)
      await f.wait(`${phase}: exact Light model terminal`, async () => {
        const terminals = (
          await f.db.information.query({
            informationId: request.informationId,
            relation: "core:status-of",
          })
        ).filter((a) =>
          [
            "core.model.task.completed",
            "core.model.task.failed",
            "core.model.task.cancelled",
          ].includes(a.kind),
        );
        expect(terminals).toHaveLength(1);
      });
    await f.wait(`${phase}: Light decision or turn terminal`, async () => {
      const decisions = (
        await f.facts("agent.light.decision.completed")
      ).filter(
        (a) => a.payload.turnContextInformationId === turn.informationId,
      );
      expect(decisions.length > 0 || (await hasTurnTerminal(f, turn))).toBe(
        true,
      );
    });
    const gates = (await f.facts("agent.attention.arousal.completed")).filter(
      (a) =>
        a.payload.candidateInformationId ===
          turn.payload.candidateInformationId &&
        a.references.some(
          (r) =>
            r.relation === "core:status-of" &&
            r.informationId === turn.payload.candidateInformationId,
        ),
    );
    if (request)
      expect(gates.some((a) => a.payload.outcome === "observe")).toBe(true);
    for (const gate of gates)
      await waitAcknowledged(
        f,
        phase,
        "router.default:agent.router.observe.agent.attention.arousal.completed",
        gate.informationId,
      );
    // observe ACK 之后读取最终决策集合，合法 superseded/terminal 路径可以没有 dispatch。
    const decisions = (await f.facts("agent.light.decision.completed")).filter(
      (a) => a.payload.turnContextInformationId === turn.informationId,
    );
    for (const decision of decisions) {
      expect(decision.references).toContainEqual({
        relation: "core:status-of",
        informationId: turn.payload.claimInformationId,
      });
      await waitAcknowledged(
        f,
        phase,
        "router.default:agent.router.dispatch-light",
        decision.informationId,
      );
    }
    // dispatch ACK 只证明终态已发布，progress 消费仍会查询并推进后续候选，必须单独等待。
    const terminals = (
      await f.db.information.query({
        informationId: String(turn.payload.candidateInformationId),
        relation: "core:status-of",
      })
    ).filter(
      (atom) =>
        atom.kind.startsWith("agent.router.turn.") &&
        atom.payload.claimInformationId === turn.payload.claimInformationId,
    );
    for (const terminal of terminals)
      await waitAcknowledged(
        f,
        phase,
        `router.default:agent.router.progress.${terminal.kind}`,
        terminal.informationId,
      );
  }
}
async function rows(f: ReplayFixture, consumer?: string) {
  const result = await f.db.sql.query<{ observation_id: string }>(
    "SELECT o.observation_id FROM information_observations o JOIN information_observation_progress p USING(stream_id) WHERE p.consumer_id=$1 ORDER BY o.recorded_at,o.observation_id",
    [consumer ?? "agent.situation"],
  );
  return Promise.all(
    result.rows.map((r) => f.db.observations.read(r.observation_id)),
  );
}
// 每条输入最多五个有界阶段：heartbeat、Focus、Identity 产物、Router ACK、规范 Memory 来源。
const ingressStages = 5;
const prefixStages = replayScenario.prefix.length * (ingressStages + 2) + 3;
async function waitCanonicalSources(f: ReplayFixture, sourceIds: string[]) {
  for (const sourceId of sourceIds)
    await f.wait(`canonical source for ${sourceId}`, async () => {
      expect(
        (await f.facts("memory.native.source.v1")).filter(
          (a) => a.payload.originalInformationId === sourceId,
        ),
      ).toHaveLength(1);
    });
}
async function waitIngressFanout(
  f: ReplayFixture,
  phase: string,
  sourceIds: string[],
) {
  const acknowledged = async (subscription: string, informationId: string) => {
    await waitAcknowledged(f, phase, subscription, informationId);
  };
  for (const sourceId of sourceIds) {
    await acknowledged("heartbeat.default:heartbeat.message", sourceId);
    // Lifecycle writes the source-bound state before the inherited heartbeat handler ACKs.
    const lifecycle = (await f.facts("agent.lifecycle.state.recorded")).filter(
      (a) =>
        a.references.some(
          (r) =>
            r.relation === "core:caused-by" && r.informationId === sourceId,
        ),
    );
    expect(lifecycle).toHaveLength(1);
    await acknowledged(
      "router.default:focus.activity",
      lifecycle[0]!.informationId,
    );
    let identityId = "";
    await f.wait(`${phase}: Identity completed for ${sourceId}`, async () => {
      const identity = (
        await f.facts("memory.identity.person.context.completed")
      ).filter((a) =>
        a.references.some(
          (r) =>
            r.relation === "core:status-of" && r.informationId === sourceId,
        ),
      );
      expect(identity).toHaveLength(1);
      identityId = identity[0]!.informationId;
    });
    await acknowledged(
      "router.default:agent.router.progress.memory.identity.person.context.completed",
      identityId,
    );
  }
}
async function waitForHeavyInput(f: ReplayFixture, sourceId: string) {
  await waitIngressFanout(f, `trigger ${sourceId}`, [sourceId]);
  let turnId = "";
  await f.wait("trigger persisted in Router turn context", async () => {
    const turn = (await f.facts("agent.router.turn.context.completed")).find(
      (a) =>
        (a.payload.inputs as any[]).some(
          (input) => input.informationId === sourceId,
        ),
    );
    expect(turn).toBeDefined();
    turnId = turn!.informationId;
  });
  await f.wait("trigger Light completed before Heavy dispatch", async () => {
    expect(
      (await f.facts("core.model.task.completed")).some(
        (a) =>
          a.payload.taskId === "agent.light.decide" &&
          a.payload.sourceInformationId === turnId,
      ),
    ).toBe(true);
  });
  await f.wait("trigger native Heavy model request persisted", async () => {
    expect(
      (await f.facts("core.model.task.requested")).some(
        (a) =>
          a.payload.taskId === "agent.heavy.respond" &&
          a.payload.nativeStep !== undefined,
      ),
    ).toBe(true);
  });
}
async function oneAction(f: ReplayFixture) {
  const result = await f.db.sql.query<{ intent_id: string }>(
    "SELECT intent_id FROM information_action_heads WHERE input->>'scope'=$1 AND input->>'providerId'='mcp.weather'",
    [replayScope()],
  );
  expect(result.rows).toHaveLength(1);
  return f.db.actions.read(result.rows[0]!.intent_id, replayScope());
}

for (const backend of backends)
  describe(`unified production replay (${backend})`, () => {
    it(
      "quiet: canonical speaker/source formation survives silence and scope/adapter isolation",
      async () => {
        const { f } = await setup(backend);
        const originals = await prefix(f);
        await prefix(f, "H");
        await prefix(f, "G", "replay.other", "other");
        await f.settled();
        const sources = (await f.facts("memory.native.source.v1")).filter((a) =>
          originals.includes(String(a.payload.originalInformationId)),
        );
        expect(
          new Set(sources.map((a: any) => a.payload.memorySource.ownerId)).size,
        ).toBe(3);
        for (const source of sources) {
          const p = source.payload as any;
          expect(p.memorySource.scope).toBe(replayScope());
          expect(p.memorySource.participants[0].ownerId).toBe(
            p.memorySource.ownerId,
          );
          const response = await f.get(`sources/${source.informationId}`);
          expect(response.statusCode).toBe(200);
          expect(response.json().data.availability).toBe("available");
          expect(
            (await f.get(`sources/${source.informationId}`, "H")).statusCode,
          ).toBe(404);
        }
        expect(f.sent).toHaveLength(0);
        expect(
          (await f.logs()).filter((r) => r.kind === "effect"),
        ).toHaveLength(0);
        expect(await f.facts("agent.router.turn.silent")).not.toHaveLength(0);
        f.complete([
          "D4.quiet-formation",
          "D8.scope-speaker-adapter-isolation",
        ]);
      },
      replayBudget(prefixStages * 3 + 1),
    );

    it(
      "late: holds a real model request while 33+ late inputs cross pages, preserving old freeze after restart",
      async () => {
        const { f, control } = await setup(backend);
        const initial = await prefix(f);
        await f.settled();
        const observationPageLimit = 4;
        const freeze = f.db.observations.freezeNext.bind(f.db.observations);
        vi.spyOn(f.db.observations, "freezeNext").mockImplementation((input) =>
          freeze({ ...input, limit: observationPageLimit }),
        );
        const barrier = gate(f);
        control.lightGate = barrier.promise;
        const receipt = await f.submit(
          f.message("freeze", "请先保留当前活动情况"),
        );
        await waitIngressFanout(f, "held Light trigger", [
          receipt.inboundInformationId,
        ]);
        let heldRequestId = "";
        await f.wait(
          "Light requested with original frozen observation",
          async () => {
            const requests = await f.facts("core.model.task.requested");
            const held = requests.find(
              (a) =>
                a.payload.taskId === "agent.light.decide" &&
                JSON.stringify(a.payload.prompt).includes(
                  "请先保留当前活动情况",
                ),
            );
            expect(held).toBeDefined();
            heldRequestId = held!.informationId;
          },
        );
        const old = (await rows(f)).filter((o) =>
          o?.manifest?.sourceInformationIds.includes(
            receipt.inboundInformationId,
          ),
        );
        expect(old.length).toBeGreaterThan(0);
        const saved = JSON.parse(JSON.stringify(old));
        const late: string[] = [];
        const completedFormations = new Set<string>();
        for (let i = 0; i < 39; i++) {
          const r = await f.submit(
            f.message(
              `late-${i}`,
              i === 32 ? replayScenario.correction : `丙的迟到活动补充${i}`,
              "G",
              i === 32 ? "乙" : "丙",
              "replay.qq",
              "2025-12-01T00:00:00.000Z",
            ),
          );
          late.push(r.inboundInformationId);
          if ((i + 1) % 8 === 0 || i === 38) {
            const expected = late.length;
            const page = late.slice(Math.floor(i / 8) * 8);
            await waitIngressFanout(
              f,
              `late ingress page ${Math.ceil(expected / 8)}`,
              page,
            );
            await waitCanonicalSources(f, page);
            expect(
              (await f.facts("memory.native.source.v1")).filter((a) =>
                late.includes(String(a.payload.originalInformationId)),
              ),
            ).toHaveLength(expected);
            // Light is deliberately held; its subscription cannot drain yet.
            // Wait for persisted formation and each independent ingress lane before the next burst.
            // Final settled() still requires every queue to drain after the gate is released.
            const requested = await f.facts(
              "memory.native.formation.requested.v1",
            );
            for (const request of requested) {
              if (completedFormations.has(request.informationId)) continue;
              await f.wait(
                `late ingress page ${Math.ceil(expected / 8)}: formation ${request.payload.batchId} completed`,
                async () => {
                  expect(
                    (
                      await f.facts("memory.native.formation.completed.v1")
                    ).some(
                      (a) =>
                        a.payload.batchId === request.payload.batchId &&
                        a.payload.status === "completed",
                    ),
                  ).toBe(true);
                },
              );
              completedFormations.add(request.informationId);
            }
          }
        }
        for (const o of old)
          expect(await f.db.observations.read(o!.observationId)).toEqual(o);
        barrier.resolve();
        control.lightGate = undefined;
        await f.wait("held Light model terminal persisted", async () => {
          const completed = await f.facts("core.model.task.completed");
          expect(
            completed.some((a) =>
              a.references.some(
                (r) =>
                  r.relation === "core:status-of" &&
                  r.informationId === heldRequestId,
              ),
            ),
          ).toBe(true);
        });
        // 同一情境的 recordSituationObservations/confirmSituationObservations 串行处理整组冻结页。
        // 确认预算按实际输入页数组成；后续模型和队列收尾仍各用独立的单阶段预算。
        const releasedPages = Math.ceil(late.length / observationPageLimit);
        await f.wait(
          `late released ${releasedPages} pages: every source observation completed`,
          async () => {
            const completed = (await rows(f)).filter(
              (o) => o?.status === "completed",
            );
            const observed = new Set(
              completed.flatMap((o) => [...o!.sourceInformationIds]),
            );
            expect(late.every((id) => observed.has(id))).toBe(true);
          },
          releasedPages,
        );
        await waitObservedTurns(f, late);
        await f.settled();
        const correctedRequest = (
          await f.facts("memory.native.formation.requested.v1")
        ).find((a: any) =>
          a.payload.sources.some((source: any) => source.id === late[32]),
        )!;
        expect(correctedRequest).toBeDefined();
        const correctedTerminal = (
          await f.facts("memory.native.formation.completed.v1")
        ).find(
          (a) =>
            a.payload.batchId === correctedRequest.payload.batchId &&
            a.payload.status === "completed",
        )!;
        const correctedNodeId = (
          correctedTerminal.payload.nodeIds as string[]
        )[0]!;
        const correctedPublication = (
          await f.facts("memory.native.revision.v1")
        ).find(
          (a: any) =>
            a.payload.operationId === correctedRequest.payload.batchId,
        );
        expect(correctedPublication).toBeDefined();
        const next = await f.submit(
          f.message(
            "corrected-successor",
            "乙已经调班，请核对周六活动的最新记忆",
          ),
        );
        await waitIngressFanout(f, "corrected successor", [
          next.inboundInformationId,
        ]);
        let successor: any;
        await f.wait(
          "successor observation freezes corrected Memory",
          async () => {
            successor = (await rows(f)).find((o) =>
              o?.manifest?.sourceInformationIds.includes(
                next.inboundInformationId,
              ),
            );
            expect(successor).toBeDefined();
            const memory = successor!.manifest!.content.memory as any;
            const node = [
              ...memory.fixed,
              ...memory.recalled.map((r: any) => r.node),
            ].find((n: any) => n.id === correctedNodeId);
            expect(node).toBeDefined();
            expect(node.metadata.sourceIds).toContain(late[32]);
            expect(node.content).toContain(replayScenario.correction);
          },
        );
        const successorTurn = await f.wait(
          "successor source-bound turn context",
          async () => {
            const turn = (
              await f.facts("agent.router.turn.context.completed")
            ).find((a: any) =>
              a.payload.inputs.some(
                (i: any) => i.informationId === next.inboundInformationId,
              ),
            );
            expect(turn).toBeDefined();
            return turn!;
          },
        );
        await f.wait("successor frozen observation confirmed", async () => {
          expect(
            (await f.db.observations.read(successor.observationId))?.status,
          ).toBe("completed");
        });
        // 冻结、确认和 Light 请求是串行持久阶段，分别等待以保留每个阶段的基础设施预算。
        await f.wait(
          "successor exact Light request contains corrected Memory",
          async () => {
            const model = (await f.facts("core.model.task.requested")).find(
              (a) =>
                a.payload.taskId === "agent.light.decide" &&
                a.payload.sourceInformationId === successorTurn.informationId,
            );
            expect(model).toBeDefined();
            expect(JSON.stringify(model!.payload.prompt)).toContain(
              correctedNodeId,
            );
          },
        );
        await waitObservedTurns(f, [next.inboundInformationId]);
        await f.settled();
        const epoch = await f.db.sql.query("SELECT * FROM memory_native_epoch");
        const before = f.requests.length;
        await f.restart();
        await f.settled();
        expect(f.requests.length).toBe(before);
        expect(
          (await f.db.sql.query("SELECT * FROM memory_native_epoch")).rows,
        ).toEqual(epoch.rows);
        for (const o of saved)
          expect(await f.db.observations.read(o.observationId)).toEqual(o);
        const memoryPages = (await rows(f, "memory.native")).filter(
          (o) =>
            o?.contract.address.adapterId === "replay.qq" &&
            (o.manifest?.content.sources as any[]).every((source) =>
              [...initial, receipt.inboundInformationId, ...late].includes(
                source.id,
              ),
            ),
        );
        expect(memoryPages.some((o) => o!.hasMore)).toBe(true);
        const ids = memoryPages.flatMap((o) => [...o!.sourceInformationIds]);
        expect(new Set(ids).size).toBe(48);
        expect(ids.length).toBe(48);
        const detail = await f.get(`observations/${old[0]!.observationId}`);
        expect(detail.statusCode).toBe(200);
        expect(detail.json().data.manifest.value.knowledgeCutoff).toEqual(
          old[0]!.manifest!.knowledgeCutoff,
        );
        expect(detail.json().data.manifest.value.sourceInformationIds).toEqual(
          old[0]!.manifest!.sourceInformationIds,
        );
        expect(detail.json().data.manifest.omitted).toContain(
          "memory-node-content:use-history",
        );
        f.complete([
          "D8.late33-cross-page",
          "D4.immutable-freeze",
          "D8.restart-no-model-replay",
        ]);
      },
      replayBudget(prefixStages + 41 * ingressStages + 32, 1),
    );

    it(
      "holes: failed production formation does not advance Memory past its gap while Situation succeeds",
      async () => {
        const { f, control } = await setup(backend);
        control.failNextFormation = true;
        const failedSources: string[] = [];
        for (const [i, text] of replayScenario.prefix.entries()) {
          const receipt = await f.submit(f.message(`failed-${i}`, text));
          failedSources.push(receipt.inboundInformationId);
        }
        await waitIngressFanout(f, "failed formation inputs", failedSources);
        await waitCanonicalSources(f, failedSources);
        let failed: any;
        await f.wait(
          "original formation failure and Memory failed page",
          async () => {
            failed = (
              await f.facts("memory.native.formation.completed.v1")
            ).find((a) => a.payload.status === "failed");
            expect(failed).toBeDefined();
            expect(
              (await rows(f, "memory.native")).some(
                (o) => o!.status === "failed",
              ),
            ).toBe(true);
          },
        );
        const firstProgress = await f.get("progress");
        const memoryBefore = firstProgress
          .json()
          .data.items.find((p: any) => p.consumerId === "memory.native");
        expect(memoryBefore.holes.length).toBeGreaterThan(0);
        await prefix(f, "G", "replay.qq", "success-after-gap");
        await f.settled();
        const during = (await f.get("progress")).json().data.items;
        const memoryDuring = during.find(
          (p: any) => p.consumerId === "memory.native",
        );
        expect(memoryDuring.successfulThrough).toBe(
          memoryBefore.successfulThrough,
        );
        expect(BigInt(memoryDuring.allocatedThrough)).toBeGreaterThan(
          BigInt(memoryDuring.successfulThrough),
        );
        expect(
          during.some(
            (p: any) =>
              p.consumerId === "agent.situation" &&
              BigInt(p.successfulThrough) > 0n,
          ),
        ).toBe(true);
        control.failBatch = "";
        await f.db.memoryGraph.native.retry(String(failed.payload.batchId));
        await f.wait(
          "successor completes original failed source gap",
          async () => {
            const progress = (await f.get("progress"))
              .json()
              .data.items.find((p: any) => p.consumerId === "memory.native");
            expect(progress.holes).toHaveLength(0);
            expect(BigInt(progress.successfulThrough)).toBeGreaterThan(
              BigInt(memoryBefore.successfulThrough),
            );
          },
        );
        expect(
          (await f.facts("memory.native.formation.completed.v1")).find(
            (a) => a.informationId === failed.informationId,
          )!.payload.status,
        ).toBe("failed");
        await f.settled();
        f.complete([
          "D4.formation-failure-successor",
          "D8.independent-watermarks-no-gap-jump",
        ]);
      },
      replayBudget(prefixStages + 8 * ingressStages + 4),
    );

    it(
      "withdraw: actual formed Memory and model output cannot authorize a withdrawn source at admission",
      async () => {
        const { f, control } = await setup(backend);
        const original = await prefix(f);
        await f.settled();
        control.speak = true;
        const barrier = gate(f);
        const admit = f.db.actions.admit.bind(f.db.actions);
        let entered = false;
        vi.spyOn(f.db.actions, "admit").mockImplementation(async (...args) => {
          entered = true;
          await barrier.promise;
          return admit(...args);
        });
        const trigger = await f.submit(
          f.message("withdraw-trigger", "读取天气工具前先核实活动"),
        );
        await waitForHeavyInput(f, trigger.inboundInformationId);
        await f.wait(
          "Heavy model completed and W3 admission gate reached",
          async () => {
            expect(entered).toBe(true);
            expect(await f.facts("core.model.task.completed")).not.toHaveLength(
              0,
            );
          },
        );
        const action = await oneAction(f);
        const observation = await f.db.observations.read(
          action.intent.dependencies.observationId,
        );
        const formed = (
          await f.facts("memory.native.formation.completed.v1")
        ).find((a) => a.payload.status === "completed")!;
        const nodeId = (formed.payload.nodeIds as string[])[0]!;
        expect(
          action.intent.dependencies.memoryRevisions.some(
            (n) => n.id === nodeId,
          ),
        ).toBe(true);
        expect(action.intent.dependencies.sourceInformationIds).toContain(
          trigger.inboundInformationId,
        );
        expect(action.intent.dependencies.sourceInformationIds).not.toContain(
          original[0],
        );
        expect(
          (
            await f.db.memoryGraph.native.checkDependencies(
              action.intent.dependencies,
            )
          ).valid,
        ).toBe(true);
        await f.db.memoryGraph.native.publish({
          operationId: "replay-withdraw",
          actor: "manual",
          nodes: [],
          invalidations: [
            {
              kind: "source-withdrawal",
              targetId: original[0]!,
              reason: "虚构 Memory 来源撤回",
            },
          ],
        });
        const invalid = await f.db.memoryGraph.native.checkDependencies(
          action.intent.dependencies,
        );
        expect(invalid.reasons).toContainEqual({
          id: nodeId,
          reason: "current-memory-invalid",
        });
        expect(invalid.reasons).toContainEqual({
          id: original[0],
          reason: "source-withdrawn",
        });
        expect(
          invalid.reasons.some((r) => r.id === trigger.inboundInformationId),
        ).toBe(false);
        barrier.resolve();
        await f.settled();
        expect((await oneAction(f)).state).toBe("rejected");
        expect(
          (await f.logs()).filter((r) => r.kind === "effect"),
        ).toHaveLength(0);
        expect(
          (await f.db.observations.read(observation!.observationId))!.manifest,
        ).toEqual(observation!.manifest);
        const canonical = (await f.facts("memory.native.source.v1")).find(
          (a) => a.payload.originalInformationId === original[0],
        )!;
        expect(
          (await f.get(`sources/${canonical.informationId}`)).json().data,
        ).toMatchObject({
          availability: "unavailable",
          content: null,
          reason: "source-withdrawal",
        });
        f.complete([
          "D6.withdraw-before-admission-zero-effect",
          "D5.withdrawn-source-redaction",
        ]);
      },
      replayBudget(prefixStages + ingressStages + 8),
    );

    it(
      "success: a proved tool result continues Heavy, delivers once and remains paired after restart",
      async () => {
        const { f, control } = await setup(backend);
        await prefix(f);
        await f.settled();
        control.speak = true;
        const trigger = await f.submit(
          f.message("success-trigger", "请读取天气并告知活动结果"),
        );
        await waitForHeavyInput(f, trigger.inboundInformationId);
        let runId = "";
        await f.wait(
          "successful MCP receipt and second Heavy request",
          async () => {
            const results = await f.facts("agent.heavy.tool.result.v1");
            expect(results).toHaveLength(1);
            expect(results[0]!.payload.value).toMatchObject({
              status: "succeeded",
              evidence: "returned",
            });
            runId = String(results[0]!.payload.runInformationId);
            expect(control.heavyCalls).toBe(2);
          },
        );
        let assistantId = "";
        let finalModelId = "";
        await f.wait(
          "native final and assistant bind the completed second model step",
          async () => {
            const terminal = (
              await f.facts("agent.heavy.tool.terminal.v1")
            ).filter((a) => a.payload.runInformationId === runId);
            expect(terminal).toHaveLength(1);
            expect(terminal[0]!.payload.reason).toBe("final");
            const result = terminal[0]!.payload.modelResult as any;
            const model = await f.db.information.get(
              result.terminalInformationId,
            );
            expect(model?.kind).toBe("core.model.task.completed");
            expect(model!.payload.nativeStep).toMatchObject({
              runInformationId: runId,
              stepIndex: 1,
            });
            finalModelId = model!.informationId;
            const assistants = await f.facts("core.message.assistant.text");
            expect(assistants).toHaveLength(1);
            expect(assistants[0]!.payload.text).toBe(
              "已读取带来源的虚构天气结果",
            );
            expect(assistants[0]!.references).toContainEqual({
              relation: "core:caused-by",
              informationId: model!.informationId,
            });
            assistantId = assistants[0]!.informationId;
          },
        );
        await f.wait(
          "one delivery refers to the native final assistant",
          async () => {
            const delivered = await f.facts("core.delivery.delivered");
            expect(delivered).toHaveLength(1);
            expect(delivered[0]!.payload.ok).toBe(true);
            const requestId = delivered[0]!.references.find(
              (r) => r.relation === "core:status-of",
            )!.informationId;
            const request = await f.db.information.get(requestId);
            expect(request?.kind).toBe("core.delivery.requested");
            expect(request!.references).toContainEqual({
              relation: "core:caused-by",
              informationId: assistantId,
            });
            expect(f.sent).toHaveLength(1);
            expect(f.sent[0]).toMatchObject({
              target: { kind: "group", groupId: "G" },
              message: { text: "已读取带来源的虚构天气结果" },
            });
          },
        );
        await f.settled();
        const action = await oneAction(f);
        expect(action.state).toBe("succeeded");
        expect(
          (await f.logs()).filter((r) => r.kind === "effect"),
        ).toHaveLength(1);
        const detail = await f.get(`runs/${runId}`);
        expect(detail.statusCode, detail.body).toBe(200);
        const projected = detail.json().data;
        expect(projected.run.terminalReason).toBe("final");
        expect(projected.steps).toHaveLength(2);
        expect(projected.steps[1].terminalInformationId).toBe(finalModelId);
        expect(projected.steps.every((s: any) => s.phase === "completed")).toBe(
          true,
        );
        expect(projected.calls).toHaveLength(1);
        expect(projected.calls[0]).toMatchObject({
          pairing: "verified",
          toolCallId: action.intent.toolCallId,
          intent: { id: action.intentId, availability: "available" },
          receipt: { id: action.receiptId, availability: "available" },
          result: { value: { status: "succeeded", evidence: "returned" } },
        });
        const successor = f.requests.filter(
          (r) =>
            r.body.model === "heavy" &&
            r.body.messages.some((m: any) => m.role === "tool"),
        );
        expect(successor).toHaveLength(1);
        expect(
          successor[0]!.body.messages.filter((m: any) => m.role === "tool"),
        ).toEqual([
          expect.objectContaining({ tool_call_id: action.intent.toolCallId }),
        ]);
        const modelCalls = f.requests.length;
        await f.restart();
        await f.settled();
        await Promise.all([
          f.server.runtime!.actions.execute(action.intentId, replayScope()),
          f.server.runtime!.actions.execute(action.intentId, replayScope()),
        ]);
        await f.settled();
        expect(f.requests).toHaveLength(modelCalls);
        expect(f.sent).toHaveLength(1);
        expect(
          (await f.logs()).filter((r) => r.kind === "effect"),
        ).toHaveLength(1);
        expect((await oneAction(f)).attemptId).toBe(action.attemptId);
        const recovered = await f.get(`runs/${runId}`);
        expect(recovered.statusCode, recovered.body).toBe(200);
        expect(recovered.json().data.calls).toEqual(projected.calls);
        f.complete([
          "D6.real-stdio-success-effect-once",
          "D8.success-restart-no-reexecution",
          "D5.success-paired-run-inspection",
        ]);
      },
      replayBudget(prefixStages + ingressStages + 12, 1),
    );

    it(
      "unknown: one actual MCP effect survives transport loss, late evidence and same-operation restart",
      async () => {
        const { f, control } = await setup(backend);
        await prefix(f);
        await f.settled();
        control.speak = true;
        await f.update({ hold: true });
        const trigger = await f.submit(
          f.message("unknown-trigger", "请读取天气并记录有来源的结果"),
        );
        await waitForHeavyInput(f, trigger.inboundInformationId);
        let action: any;
        await f.wait(
          "independent MCP effect journal and W3 started identity",
          async () => {
            expect(
              (await f.logs()).filter((r) => r.kind === "effect"),
            ).toHaveLength(1);
            action = await oneAction(f);
            expect(action.state).toBe("started");
          },
        );
        const stopped = await f.server.runtime!.actions.cancel({
          intentId: action.intentId,
          scope: replayScope(),
          causeInformationId:
            action.intent.sourceInformationId ?? action.intent.runInformationId,
          controlAuthorizationId: action.intent.authorizationId,
        });
        expect(stopped.state).not.toBe("cancelled");
        await f.wait("original attempt is durably unknown", async () => {
          expect((await oneAction(f)).state).toBe("unknown");
        });
        await f.update({ hold: true, release: true });
        await f.wait(
          "late MCP response is independently persisted",
          async () => {
            expect(await f.facts("mcp.client.late-result.v1")).toHaveLength(1);
          },
        );
        await f.settled();
        const detail = await f.get(`actions/${action.intentId}`);
        expect(detail.statusCode).toBe(200);
        const projected = detail.json().data;
        expect(projected.action.state).toBe("unknown");
        expect(projected.lateEvidence).toHaveLength(1);
        expect(projected.lateEvidence[0].informationId).toBe(
          (await f.facts("mcp.client.late-result.v1"))[0]!.informationId,
        );
        expect(projected.lateEvidence[0].requests.value[0]).toMatchObject({
          intentId: action.intentId,
          operationId: action.intent.operationId,
          attemptId: action.attemptId,
          modelToolCallId: action.intent.toolCallId,
        });
        expect(
          (await f.get(`actions/${action.intentId}`, "H")).statusCode,
        ).toBe(404);
        await f.restart();
        await f.settled();
        await Promise.all([
          f.server.runtime!.actions.execute(action.intentId, replayScope()),
          f.server.runtime!.actions.execute(action.intentId, replayScope()),
        ]);
        await f.settled();
        expect((await oneAction(f)).state).toBe("unknown");
        expect(
          (await f.logs()).filter((r) => r.kind === "effect"),
        ).toHaveLength(1);
        expect((await oneAction(f)).attemptId).toBe(action.attemptId);
        f.complete([
          "D6.real-stdio-effect-once",
          "D8.unknown-late-restart-workers",
          "D5.scoped-action-inspection",
        ]);
      },
      replayBudget(prefixStages + ingressStages + 11, 1),
    );
  });
