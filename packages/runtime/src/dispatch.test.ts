import { EventBus, WorkflowEngine } from "@kaguya/engine";
import type { EventEnvelope } from "@kaguya/schema";
import { z } from "@kaguya/schema";
import {
  defineEvent,
  defineNode,
  defineWorkflow,
  type WorkflowContext,
} from "@kaguya/sdk";
import { describe, expect, it, vi } from "vitest";

import { dispatchEvent } from "./dispatch.js";

const NOW = "2026-08-14T00:00:00.000Z";
const inputEvent = defineEvent(
  "test.input",
  z.object({ text: z.string().trim().min(1) }).strict(),
);

function harness() {
  const effect = vi.fn();
  const context: WorkflowContext = {
    traceId: "trace-1",
    now: () => new Date(NOW),
    nextId: (prefix) => `${prefix}-1`,
    services: {},
  };
  return {
    effect,
    context,
    eventBus: new EventBus(),
    engine: new WorkflowEngine({ recorder: { record: async () => undefined } }),
    workflow: defineWorkflow({
      id: "test-workflow",
      nodes: [
        defineNode<EventEnvelope, EventEnvelope>({
          id: "effect",
          async run(event) {
            effect(event);
            return event;
          },
        }),
      ],
      edges: [],
    }),
  };
}

function event(traceId = "trace-1") {
  return inputEvent.create(
    {
      id: "event-1",
      source: "test",
      occurredAt: NOW,
      traceId,
      metadata: {},
    },
    { text: "valid" },
  );
}

describe("dispatchEvent", () => {
  it("rejects a trace mismatch before workflow effects", async () => {
    const runtime = harness();
    await expect(
      dispatchEvent({
        definition: inputEvent,
        event: event("trace-other"),
        eventBus: runtime.eventBus,
        engine: runtime.engine,
        workflow: runtime.workflow,
        context: runtime.context,
      }),
    ).rejects.toMatchObject({ name: "EventValidationError" });
    expect(runtime.effect).not.toHaveBeenCalled();
  });

  it("rejects an interceptor trace rewrite", async () => {
    const runtime = harness();
    runtime.eventBus.subscribe(
      inputEvent.type,
      (source) => ({
        continue: true,
        event: { ...source, traceId: "forged" },
      }),
      { mode: "intercept" },
    );
    await expect(
      dispatchEvent({
        definition: inputEvent,
        event: event(),
        eventBus: runtime.eventBus,
        engine: runtime.engine,
        workflow: runtime.workflow,
        context: runtime.context,
      }),
    ).rejects.toMatchObject({ name: "EventValidationError" });
  });

  it("validates concrete payloads before running a workflow", async () => {
    const runtime = harness();
    const invalid = { ...event(), payload: { text: " " } };
    await expect(
      dispatchEvent({
        definition: inputEvent,
        event: invalid,
        eventBus: runtime.eventBus,
        engine: runtime.engine,
        workflow: runtime.workflow,
        context: runtime.context,
      }),
    ).rejects.toMatchObject({
      name: "EventValidationError",
      phase: "payload",
    });
  });
});
