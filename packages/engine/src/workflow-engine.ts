import type { EventRun } from "@kaguya/schema";
import type {
  WorkflowContext,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowFailureDescriptor,
  WorkflowNode,
} from "@kaguya/sdk";
import { classifyWorkflowFailure } from "@kaguya/sdk";

export interface WorkflowRunRecorder {
  record(run: EventRun): Promise<void>;
}

export interface WorkflowEngineOptions {
  recorder?: WorkflowRunRecorder;
}

export interface WorkflowExecutionResult {
  workflowId: string;
  traceId: string;
  completedNodeIds: string[];
  outputs: Record<string, unknown>;
}

export class RetryableError extends Error implements WorkflowFailureDescriptor {
  readonly kind = "retryable" as const;

  constructor(message: string) {
    super(message);
    this.name = "RetryableError";
  }
}

export class AbortError extends Error implements WorkflowFailureDescriptor {
  readonly kind = "cancelled" as const;

  constructor(message = "Workflow execution was aborted") {
    super(message);
    this.name = "AbortError";
  }
}

export class WorkflowRunRecordingError extends Error {
  constructor(
    readonly runId: string,
    readonly terminalStatus: "cancelled" | "failed",
    override readonly cause: unknown,
  ) {
    super(`Failed to record ${terminalStatus} workflow run ${runId}`, {
      cause,
    });
    this.name = "WorkflowRunRecordingError";
  }
}

export class WorkflowEngine {
  constructor(private readonly options: WorkflowEngineOptions = {}) {}

  async run(
    workflow: WorkflowDefinition,
    input: unknown,
    context: WorkflowContext,
  ): Promise<WorkflowExecutionResult> {
    const nodes = new Map(workflow.nodes.map((node) => [node.id, node]));
    const adjacency = createAdjacencyMap(workflow);
    const startNodeId = resolveStartNodeId(workflow, adjacency);
    const queue: Array<{ nodeId: string; input: unknown }> = [
      { nodeId: startNodeId, input },
    ];
    const scheduledNodeIds = new Set([startNodeId]);
    const completedNodeIds: string[] = [];
    const outputs: Record<string, unknown> = {};

    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) {
        continue;
      }

      const node = nodes.get(next.nodeId);
      if (node === undefined) {
        throw new Error(`workflow node does not exist: ${next.nodeId}`);
      }

      const runId = context.nextId("event-run");
      const startedAt = context.now().toISOString();
      await this.options.recorder?.record({
        id: runId,
        traceId: context.traceId,
        workflowId: workflow.id,
        nodeId: node.id,
        startedAt,
        status: "running",
      });

      let output: unknown;
      try {
        output = await executeNode(node, next.input, context);
      } catch (error) {
        const normalizedError = normalizeError(error);
        const completedAt = context.now().toISOString();
        const classification = classifyWorkflowFailure(normalizedError);
        const terminalRun: EventRun =
          classification.status === "cancelled"
            ? {
                id: runId,
                traceId: context.traceId,
                workflowId: workflow.id,
                nodeId: node.id,
                startedAt,
                completedAt,
                status: "cancelled",
              }
            : {
                id: runId,
                traceId: context.traceId,
                workflowId: workflow.id,
                nodeId: node.id,
                startedAt,
                completedAt,
                status: "failed",
                retryable: classification.retryable,
                error: {
                  name: normalizedError.name,
                  message: normalizedError.message,
                },
              };
        try {
          await this.options.recorder?.record(terminalRun);
        } catch (recordingCause) {
          attachRecordingError(
            normalizedError,
            new WorkflowRunRecordingError(
              runId,
              terminalRun.status,
              recordingCause,
            ),
          );
        }
        throw normalizedError;
      }

      const completedAt = context.now().toISOString();
      await this.options.recorder?.record({
        id: runId,
        traceId: context.traceId,
        workflowId: workflow.id,
        nodeId: node.id,
        startedAt,
        completedAt,
        status: "completed",
        output,
      });
      completedNodeIds.push(node.id);
      outputs[node.id] = output;

      for (const edge of adjacency.get(node.id) ?? []) {
        if (edge.when?.(output) !== false && !scheduledNodeIds.has(edge.to)) {
          scheduledNodeIds.add(edge.to);
          queue.push({ nodeId: edge.to, input: output });
        }
      }
    }

    return {
      workflowId: workflow.id,
      traceId: context.traceId,
      completedNodeIds,
      outputs,
    };
  }
}

function attachRecordingError(
  error: Error,
  recordingError: WorkflowRunRecordingError,
): void {
  try {
    Object.defineProperty(error, "recordingError", {
      value: recordingError,
      configurable: true,
      enumerable: true,
      writable: true,
    });
  } catch {
    // A frozen/non-extensible node error must remain the primary failure.
  }
}

function createAdjacencyMap(
  workflow: WorkflowDefinition,
): Map<string, WorkflowEdge[]> {
  const adjacency = new Map<string, WorkflowEdge[]>();
  for (const node of workflow.nodes) {
    adjacency.set(node.id, []);
  }
  for (const edge of workflow.edges) {
    adjacency.get(edge.from)?.push(edge);
  }
  return adjacency;
}

function resolveStartNodeId(
  workflow: WorkflowDefinition,
  adjacency: Map<string, WorkflowEdge[]>,
): string {
  if (workflow.startNodeId !== undefined) {
    return workflow.startNodeId;
  }

  const destinations = new Set(workflow.edges.map((edge) => edge.to));
  const entryNodeIds = [...adjacency.keys()].filter(
    (nodeId) => !destinations.has(nodeId),
  );
  if (entryNodeIds.length !== 1) {
    throw new Error("workflow has ambiguous entry nodes; specify startNodeId");
  }

  return entryNodeIds[0] as string;
}

async function executeNode(
  node: WorkflowNode,
  input: unknown,
  context: WorkflowContext,
): Promise<unknown> {
  return node.run(input, context);
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
