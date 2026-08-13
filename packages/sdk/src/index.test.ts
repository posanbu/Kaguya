import { z } from "@kaguya/schema";
import { describe, expect, it } from "vitest";

import {
  defineEvent,
  defineModule,
  defineNode,
  defineWorkflow,
  onEvent,
  onTargetedEvent,
} from "./index.js";
import * as sdk from "./index.js";

const baseEvent = {
  id: "event-1",
  source: "test",
  occurredAt: "2026-07-23T00:00:00.000Z",
  traceId: "trace-1",
  sessionId: "session-1",
  metadata: {},
};

describe("defineEvent", () => {
  it("preserves typed event payloads", () => {
    const messageReceived = defineEvent(
      "message.received",
      z.object({ messageId: z.string() }),
      { sessionScoped: true },
    );

    expect(
      messageReceived.create(baseEvent, { messageId: "m-1" }).payload.messageId,
    ).toBe("m-1");
  });
});

describe("defineWorkflow", () => {
  it("rejects duplicate node ids", () => {
    const node = defineNode({
      id: "load",
      run: async (input: string) => input,
    });

    expect(() =>
      defineWorkflow({ id: "duplicate", nodes: [node, node], edges: [] }),
    ).toThrow("duplicate node id: load");
  });

  it("rejects edges with missing endpoints", () => {
    const node = defineNode({
      id: "load",
      run: async (input: string) => input,
    });

    expect(() =>
      defineWorkflow({
        id: "missing-endpoint",
        nodes: [node],
        edges: [{ from: "load", to: "save" }],
      }),
    ).toThrow("edge endpoint does not exist: load -> save");
  });

  it("rejects cyclic workflows", () => {
    const first = defineNode({
      id: "first",
      run: async (input: string) => input,
    });
    const second = defineNode({
      id: "second",
      run: async (input: string) => input,
    });

    expect(() =>
      defineWorkflow({
        id: "cyclic",
        nodes: [first, second],
        edges: [
          { from: "first", to: "second" },
          { from: "second", to: "first" },
        ],
      }),
    ).toThrow("workflow contains a cycle");
  });
});

describe("workflow failure classification", () => {
  it("exposes a shared structural classifier for retryable, cancelled, and terminal failures", () => {
    const classifyWorkflowFailure = (
      sdk as {
        classifyWorkflowFailure?: (
          error: unknown,
        ) => { status: "cancelled" } | { status: "failed"; retryable: boolean };
      }
    ).classifyWorkflowFailure;

    expect(classifyWorkflowFailure).toBeTypeOf("function");
    if (classifyWorkflowFailure === undefined) {
      throw new Error("classifyWorkflowFailure is unavailable");
    }
    expect(classifyWorkflowFailure({ kind: "retryable" })).toEqual({
      status: "failed",
      retryable: true,
    });
    expect(classifyWorkflowFailure({ kind: "cancelled" })).toEqual({
      status: "cancelled",
    });
    expect(classifyWorkflowFailure({ kind: "non-retryable" })).toEqual({
      status: "failed",
      retryable: false,
    });
    expect(classifyWorkflowFailure(new Error("unclassified"))).toEqual({
      status: "failed",
      retryable: false,
    });
    expect(
      classifyWorkflowFailure(
        new AggregateError([
          new AggregateError([{ kind: "retryable" }]),
          { kind: "retryable" },
        ]),
      ),
    ).toEqual({ status: "failed", retryable: true });
    expect(
      classifyWorkflowFailure(
        new AggregateError([{ kind: "retryable" }, { kind: "non-retryable" }]),
      ),
    ).toEqual({ status: "failed", retryable: false });
  });
});

describe("module SDK", () => {
  it("defines modules with discoverable settings and typed subscriptions", () => {
    const broadcast = defineEvent(
      "test.broadcast",
      z.object({ value: z.string() }),
    );
    const targeted = defineEvent(
      "test.targeted",
      z.object({ targetInstanceId: z.string(), value: z.string() }),
    );
    const definition = defineModule({
      manifest: {
        apiVersion: 1,
        definitionId: "test.module",
        displayName: "Test module",
        settingsSchema: z.object({ prefix: z.string() }),
      },
      create: ({ settings }) => ({
        subscriptions: [
          onEvent(broadcast, () => {
            void settings.prefix;
          }),
          onTargetedEvent(targeted, () => {
            void settings.prefix;
          }),
        ],
      }),
    });

    expect(definition.manifest.settingsSchema.parse({ prefix: "ok" })).toEqual({
      prefix: "ok",
    });
    expect(
      definition.create({ instanceId: "test.1", settings: { prefix: "ok" } }),
    ).toMatchObject({
      subscriptions: [
        { targeted: false, event: broadcast },
        { targeted: true, event: targeted },
      ],
    });
  });

  it("rejects invalid module manifests", () => {
    expect(() =>
      defineModule({
        manifest: {
          apiVersion: 1,
          definitionId: " ",
          displayName: "Invalid",
          settingsSchema: z.object({}),
        },
        create: () => ({ subscriptions: [] }),
      }),
    ).toThrow("module definition id must not be empty");
  });
});
