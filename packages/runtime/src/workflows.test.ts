import { WorkflowEngine } from "@kaguya/engine";
import type { EventEnvelope } from "@kaguya/schema";
import type { WorkflowContext } from "@kaguya/sdk";
import { describe, expect, it } from "vitest";

import { heartbeatTickEvent, memoryScheduleTickEvent } from "./events.js";
import { createHeartbeatWorkflow, createMemoryWorkflow } from "./workflows.js";

const context: WorkflowContext = {
  traceId: "trace-1",
  now: () => new Date("2026-08-14T00:00:00.000Z"),
  nextId: (prefix) => `${prefix}-1`,
  services: {},
};

const engine = () =>
  new WorkflowEngine({ recorder: { record: async () => undefined } });

function base() {
  return {
    id: "event-1",
    source: "test",
    occurredAt: "2026-08-14T00:00:00.000Z",
    traceId: "trace-1",
    metadata: {},
  };
}

describe("explicit-context legacy workflows", () => {
  it("heartbeat accepts caller-owned context and message selection", async () => {
    const event = heartbeatTickEvent.create(base(), {
      contextKey: "module-owned-context",
      messageIds: ["message-1", "message-2"],
    });
    const result = await engine().run(
      createHeartbeatWorkflow(),
      event,
      context,
    );
    expect(result.outputs["accept-explicit-context"]).toEqual(event.payload);
  });

  it("memory scheduling never scans Core messages for sessions", async () => {
    const event = memoryScheduleTickEvent.create(base(), {
      from: "2026-08-13T00:00:00.000Z",
      to: "2026-08-14T00:00:00.000Z",
      contexts: [
        { contextKey: "module-a", messageIds: ["message-1"] },
        { contextKey: "module-b", messageIds: [] },
      ],
    });
    const result = await engine().run(createMemoryWorkflow(), event, context);
    expect(result.outputs["accept-explicit-contexts"]).toEqual({
      contextKeys: ["module-a", "module-b"],
    });
  });

  it("events and workflow context have no session field", () => {
    const event: EventEnvelope = heartbeatTickEvent.create(base(), {
      contextKey: "owned",
      messageIds: [],
    });
    expect(event).not.toHaveProperty("sessionId");
    expect(context).not.toHaveProperty("sessionId");
  });
});
