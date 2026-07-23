import { describe, expect, it } from "vitest";

import {
  eventEnvelopeSchema,
  llmTraceSchema,
  promptFragmentSchema,
} from "./index.js";

describe("eventEnvelopeSchema", () => {
  it("rejects a session event without sessionId", () => {
    expect(eventEnvelopeSchema).toBeDefined();

    expect(() =>
      eventEnvelopeSchema.parse({
        id: "event-1",
        type: "message.received",
        source: "test",
        occurredAt: "2026-07-23T00:00:00.000Z",
        traceId: "trace-1",
        payload: {},
        metadata: {},
      }),
    ).toThrow();
  });

  it("accepts a global scheduled-memory event without a session", () => {
    expect(
      eventEnvelopeSchema.parse({
        id: "event-1",
        type: "memory.schedule.tick",
        source: "scheduler",
        occurredAt: "2026-07-23T00:00:00.000Z",
        traceId: "trace-1",
        payload: {},
        metadata: {},
      }),
    ).toMatchObject({ type: "memory.schedule.tick" });
  });
});

describe("promptFragmentSchema", () => {
  it("rejects an unsupported fragment source", () => {
    expect(promptFragmentSchema).toBeDefined();

    expect(() =>
      promptFragmentSchema.parse({
        id: "fragment-1",
        source: "unsupported",
        priority: 1,
        content: "instructions",
        metadata: {},
      }),
    ).toThrow();
  });
});

describe("llmTraceSchema", () => {
  const prompt = {
    kind: "route" as const,
    text: '<policy source="policy-id">decide</policy>',
    fragments: [
      {
        id: "policy-id",
        source: "policy" as const,
        priority: 1,
        content: "decide",
        metadata: {},
      },
    ],
    provenance: [
      {
        fragmentId: "policy-id",
        source: "policy" as const,
        priority: 1,
        contentDigest: "digest",
      },
    ],
  };

  it("preserves the complete prompt on completed traces", () => {
    const parsed = llmTraceSchema.parse({
      id: "llm-trace-1",
      traceId: "trace-1",
      workflowId: "workflow-1",
      nodeId: "node-1",
      kind: "route",
      modelId: "model-1",
      prompt,
      startedAt: "2026-07-23T00:00:00.000Z",
      completedAt: "2026-07-23T00:00:00.010Z",
      durationMs: 10,
      status: "completed",
      response: { shouldReply: true },
    });

    expect(parsed).toMatchObject({ prompt });
  });

  it("preserves prompt and normalized error kind on failed traces", () => {
    const parsed = llmTraceSchema.parse({
      id: "llm-trace-2",
      traceId: "trace-1",
      workflowId: "workflow-1",
      nodeId: "node-1",
      kind: "route",
      modelId: "model-1",
      prompt,
      startedAt: "2026-07-23T00:00:00.000Z",
      completedAt: "2026-07-23T00:00:00.010Z",
      durationMs: 10,
      status: "failed",
      error: {
        name: "KaguyaLlmError",
        message: "provider unavailable",
        kind: "retryable",
      },
    });

    expect(parsed).toMatchObject({
      prompt,
      error: { kind: "retryable" },
    });
  });
});
