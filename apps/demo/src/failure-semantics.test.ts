import { WorkflowEngine } from "@kaguya/engine";
import { KaguyaLlmError } from "@kaguya/llm/client";
import type { EventRun } from "@kaguya/schema";
import { defineNode, defineWorkflow, type WorkflowContext } from "@kaguya/sdk";
import { describe, expect, it } from "vitest";

const context: WorkflowContext = {
  traceId: "trace-real-llm-error",
  sessionId: "session-real-llm-error",
  now: () => new Date("2026-07-23T00:00:00.000Z"),
  nextId: (prefix) => `${prefix}-1`,
  services: {},
};

describe("Kaguya LLM workflow failure classification", () => {
  it.each([
    [
      "retryable",
      {
        status: "failed",
        retryable: true,
        error: { name: "KaguyaLlmError" },
      },
    ],
    ["cancelled", { status: "cancelled" }],
  ] as const)(
    "records a real %s KaguyaLlmError correctly",
    async (kind, expected) => {
      const records: EventRun[] = [];
      const error = new KaguyaLlmError(`${kind} generation`, {
        kind,
        cause: new Error("provider cause"),
      });
      const workflow = defineWorkflow({
        id: `${kind}-real-llm-error`,
        nodes: [
          defineNode({
            id: "generate",
            run: async () => {
              throw error;
            },
          }),
        ],
        edges: [],
      });
      const engine = new WorkflowEngine({
        recorder: {
          record(run) {
            records.push(run);
            return Promise.resolve();
          },
        },
      });

      const caught = await engine
        .run(workflow, undefined, context)
        .catch((failure: unknown) => failure);

      expect(caught).toBe(error);
      expect(records.at(-1)).toMatchObject(expected);
    },
  );
});
