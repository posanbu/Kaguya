import { EventBus } from "@kaguya/engine";
import { KaguyaLlmClient } from "@kaguya/llm/client";
import { createRepeatingDeterministicModel } from "@kaguya/llm/testing";
import type { EventEnvelope, LlmTrace } from "@kaguya/schema";
import { describe, expect, it } from "vitest";

import { llmCompletedEvent, llmRequestedEvent } from "./events.js";
import { LlmLifecycleClient } from "./llm-lifecycle.js";

describe("LlmLifecycleClient", () => {
  it("links lifecycle events to the module event and preserves the root cause", async () => {
    const eventBus = new EventBus();
    const observed: EventEnvelope[] = [];
    for (const type of [llmRequestedEvent.type, llmCompletedEvent.type]) {
      eventBus.subscribe(type, (event) => observed.push(event), {
        mode: "observe",
      });
    }
    const traces: LlmTrace[] = [];
    const client = new LlmLifecycleClient(
      new KaguyaLlmClient({
        model: createRepeatingDeterministicModel({ text: "hello" }),
        traceWriter: {
          write(trace) {
            traces.push(trace);
            return Promise.resolve();
          },
        },
        now: () => new Date("2026-08-14T00:00:02.000Z"),
      }),
      eventBus,
    );
    let sequence = 0;
    const sourceEvent: EventEnvelope = {
      id: "reply-requested-1",
      type: "reply.requested",
      source: "module:filter.default",
      occurredAt: "2026-08-14T00:00:01.000Z",
      traceId: "trace-1",
      payload: {},
      metadata: { rootEventId: "message-ingested-1" },
    };
    const context = {
      traceId: "trace-1",
      definitionId: "demo.reply.llm",
      instanceId: "reply.default",
      sourceEvent,
      now: () => new Date("2026-08-14T00:00:02.000Z"),
      nextId: (prefix: string) => `${prefix}-${++sequence}`,
    };

    await client.generate(
      {
        kind: "reply",
        modelId: "actual-heavy-model",
        prompt: { kind: "reply", text: "hello", fragments: [], provenance: [] },
        traceId: "trace-1",
        workflowId: "module-message",
        nodeId: "reply.default",
      },
      context,
    );

    const requested = observed[0];
    const completed = observed[1];
    expect(requested).toMatchObject({
      traceId: "trace-1",
      payload: { modelId: "actual-heavy-model" },
      metadata: {
        causationEventId: "reply-requested-1",
        rootEventId: "message-ingested-1",
        moduleDefinitionId: "demo.reply.llm",
        moduleInstanceId: "reply.default",
      },
    });
    expect(completed).toMatchObject({
      traceId: "trace-1",
      metadata: {
        causationEventId: requested?.id,
        rootEventId: "message-ingested-1",
      },
    });
    expect(traces).toEqual([
      expect.objectContaining({
        traceId: "trace-1",
        modelId: "actual-heavy-model",
        causationEventId: "reply-requested-1",
        rootEventId: "message-ingested-1",
      }),
    ]);
  });
});
