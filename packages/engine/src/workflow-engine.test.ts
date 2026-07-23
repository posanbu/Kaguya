import type { EventRun } from "@kaguya/schema";
import { defineNode, defineWorkflow, type WorkflowContext } from "@kaguya/sdk";
import { describe, expect, it } from "vitest";

import {
  RetryableError,
  WorkflowEngine,
  type WorkflowRunRecorder,
} from "./workflow-engine.js";

const context: WorkflowContext = {
  traceId: "trace-1",
  sessionId: "session-1",
  now: () => new Date("2026-07-23T00:00:00.000Z"),
  nextId: (prefix) => `${prefix}-1`,
  services: {},
};

function createRecorder(): {
  recorder: WorkflowRunRecorder;
  records: EventRun[];
} {
  const records: EventRun[] = [];
  return {
    recorder: {
      async record(run) {
        records.push(run);
      },
    },
    records,
  };
}

describe("WorkflowEngine", () => {
  it("flows output through a two-node graph and records node lifecycle", async () => {
    const { recorder, records } = createRecorder();
    const workflow = defineWorkflow({
      id: "two-node",
      nodes: [
        defineNode({
          id: "first",
          run: async (input: string) => `${input}-one`,
        }),
        defineNode({
          id: "second",
          run: async (input: string) => `${input}-two`,
        }),
      ],
      edges: [{ from: "first", to: "second" }],
    });

    const result = await new WorkflowEngine({ recorder }).run(
      workflow,
      "start",
      context,
    );

    expect(result).toEqual({
      workflowId: "two-node",
      traceId: "trace-1",
      completedNodeIds: ["first", "second"],
      outputs: { first: "start-one", second: "start-one-two" },
    });
    expect(records.map((record) => record.status)).toEqual([
      "running",
      "completed",
      "running",
      "completed",
    ]);
  });

  it("skips an outgoing edge whose when condition is false", async () => {
    const skipped = defineNode({
      id: "skipped",
      run: async () => "should not run",
    });
    const workflow = defineWorkflow({
      id: "conditional",
      nodes: [defineNode({ id: "first", run: async () => "output" }), skipped],
      edges: [{ from: "first", to: "skipped", when: () => false }],
    });

    const result = await new WorkflowEngine().run(workflow, undefined, context);

    expect(result.completedNodeIds).toEqual(["first"]);
    expect(result.outputs).toEqual({ first: "output" });
  });

  it("runs a converging node once using the first queued input", async () => {
    const { recorder, records } = createRecorder();
    const joinInputs: string[] = [];
    const workflow = defineWorkflow({
      id: "converging",
      nodes: [
        defineNode({ id: "start", run: async () => "start" }),
        defineNode({
          id: "left",
          run: async (input: string) => `${input}-left`,
        }),
        defineNode({
          id: "right",
          run: async (input: string) => `${input}-right`,
        }),
        defineNode({
          id: "join",
          run: async (input: string) => {
            joinInputs.push(input);
            return input;
          },
        }),
      ],
      edges: [
        { from: "start", to: "left" },
        { from: "start", to: "right" },
        { from: "left", to: "join" },
        { from: "right", to: "join" },
      ],
    });

    const result = await new WorkflowEngine({ recorder }).run(
      workflow,
      undefined,
      context,
    );

    expect(joinInputs).toEqual(["start-left"]);
    expect(result.completedNodeIds).toEqual(["start", "left", "right", "join"]);
    expect(records.filter((record) => record.nodeId === "join")).toEqual([
      expect.objectContaining({ status: "running" }),
      expect.objectContaining({ status: "completed", output: "start-left" }),
    ]);
  });

  it("records failed nodes with their error class and retryability", async () => {
    const { recorder, records } = createRecorder();
    const workflow = defineWorkflow({
      id: "failing",
      nodes: [
        defineNode({
          id: "fail",
          run: async () => {
            throw new RetryableError("try again");
          },
        }),
      ],
      edges: [],
    });

    await expect(
      new WorkflowEngine({ recorder }).run(workflow, undefined, context),
    ).rejects.toThrow("try again");
    expect(records).toEqual([
      expect.objectContaining({ status: "running", nodeId: "fail" }),
      expect.objectContaining({
        status: "failed",
        nodeId: "fail",
        retryable: true,
        error: { name: "RetryableError", message: "try again" },
      }),
    ]);
  });

  it("classifies a structural retryable LLM failure without depending on llm", async () => {
    const { recorder, records } = createRecorder();
    const llmError = Object.assign(new Error("provider overloaded"), {
      name: "KaguyaLlmError",
      kind: "retryable" as const,
    });
    const workflow = defineWorkflow({
      id: "retryable-llm-failure",
      nodes: [
        defineNode({
          id: "generate",
          run: async () => {
            throw llmError;
          },
        }),
      ],
      edges: [],
    });

    const caught = await new WorkflowEngine({ recorder })
      .run(workflow, undefined, context)
      .catch((error: unknown) => error);

    expect(caught).toBe(llmError);
    expect(records.at(-1)).toMatchObject({
      status: "failed",
      retryable: true,
      error: { name: "KaguyaLlmError", message: "provider overloaded" },
    });
  });

  it("classifies a structural cancelled LLM failure as cancelled", async () => {
    const { recorder, records } = createRecorder();
    const llmError = Object.assign(new Error("cancelled by caller"), {
      name: "KaguyaLlmError",
      kind: "cancelled" as const,
    });
    const workflow = defineWorkflow({
      id: "cancelled-llm-failure",
      nodes: [
        defineNode({
          id: "generate",
          run: async () => {
            throw llmError;
          },
        }),
      ],
      edges: [],
    });

    const caught = await new WorkflowEngine({ recorder })
      .run(workflow, undefined, context)
      .catch((error: unknown) => error);

    expect(caught).toBe(llmError);
    expect(records.at(-1)).toMatchObject({
      status: "cancelled",
      nodeId: "generate",
    });
  });

  it("keeps the node error primary when terminal recording also fails", async () => {
    const nodeError = new Error("node failed");
    const recorderError = new Error("recorder unavailable");
    let recordCalls = 0;
    const recorder: WorkflowRunRecorder = {
      record() {
        recordCalls += 1;
        return recordCalls === 1
          ? Promise.resolve()
          : Promise.reject(recorderError);
      },
    };
    const workflow = defineWorkflow({
      id: "node-and-recorder-failure",
      nodes: [
        defineNode({
          id: "fail",
          run: async () => {
            throw nodeError;
          },
        }),
      ],
      edges: [],
    });

    const caught = await new WorkflowEngine({ recorder })
      .run(workflow, undefined, context)
      .catch((error: unknown) => error);

    expect(caught).toBe(nodeError);
    expect(caught).toMatchObject({
      recordingError: {
        name: "WorkflowRunRecordingError",
        cause: recorderError,
        runId: "event-run-1",
        terminalStatus: "failed",
      },
    });
  });

  it("keeps a frozen node error primary when recording annotation is impossible", async () => {
    const nodeError = Object.freeze(new Error("frozen node failed"));
    const recorderError = new Error("recorder unavailable");
    let recordCalls = 0;
    const recorder: WorkflowRunRecorder = {
      record() {
        recordCalls += 1;
        return recordCalls === 1
          ? Promise.resolve()
          : Promise.reject(recorderError);
      },
    };
    const workflow = defineWorkflow({
      id: "frozen-node-and-recorder-failure",
      nodes: [
        defineNode({
          id: "fail",
          run: async () => {
            throw nodeError;
          },
        }),
      ],
      edges: [],
    });

    const caught = await new WorkflowEngine({ recorder })
      .run(workflow, undefined, context)
      .catch((error: unknown) => error);

    expect(caught).toBe(nodeError);
    expect(Object.hasOwn(caught as object, "recordingError")).toBe(false);
    expect(recordCalls).toBe(2);
  });
});
