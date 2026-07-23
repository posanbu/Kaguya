import { eventEnvelopeSchema, type EventEnvelope, z } from "@kaguya/schema";

export interface EventDefinition<TType extends string, TPayload> {
  type: TType;
  payloadSchema: z.ZodType<TPayload>;
  sessionScoped: boolean;
  create(
    base: Omit<EventEnvelope, "type" | "payload">,
    payload: TPayload,
  ): EventEnvelope<TType, TPayload>;
}

export function defineEvent<TType extends string, TPayload>(
  type: TType,
  payloadSchema: z.ZodType<TPayload>,
  options: { sessionScoped?: boolean } = {},
): EventDefinition<TType, TPayload> {
  const sessionScoped = options.sessionScoped ?? false;

  return {
    type,
    payloadSchema,
    sessionScoped,
    create(base, payload) {
      const event: EventEnvelope<TType, TPayload> = {
        ...base,
        type,
        payload: payloadSchema.parse(payload),
      };

      if (sessionScoped && event.sessionId === undefined) {
        throw new Error(`${type} requires sessionId`);
      }

      eventEnvelopeSchema.parse(event);
      return event;
    },
  };
}

export interface ListenerOptions {
  name?: string;
  priority?: number;
  mode?: "intercept" | "observe";
}

export interface ListenerDefinition<
  TEvent extends EventEnvelope = EventEnvelope,
> {
  type: TEvent["type"];
  handler: (event: TEvent) => Promise<unknown> | unknown;
  options: ListenerOptions;
}

export function defineListener<TType extends string, TPayload>(
  type: TType,
  handler: (
    event: EventEnvelope<TType, TPayload>,
  ) => Promise<unknown> | unknown,
  options: ListenerOptions = {},
): ListenerDefinition<EventEnvelope<TType, TPayload>> {
  return { type, handler, options };
}

export interface WorkflowContext {
  traceId: string;
  sessionId?: string;
  now(): Date;
  nextId(prefix: string): string;
  services: Record<string, unknown>;
}

export type WorkflowFailureKind = "cancelled" | "non-retryable" | "retryable";

export interface WorkflowFailureDescriptor {
  readonly kind: WorkflowFailureKind;
}

export type WorkflowFailureClassification =
  { status: "cancelled" } | { status: "failed"; retryable: boolean };

export function classifyWorkflowFailure(
  error: unknown,
): WorkflowFailureClassification {
  const kind = structuralFailureKind(error);
  if (kind === "cancelled" || isNamedAbortError(error)) {
    return { status: "cancelled" };
  }
  return { status: "failed", retryable: kind === "retryable" };
}

function structuralFailureKind(
  error: unknown,
): WorkflowFailureKind | undefined {
  if (typeof error !== "object" || error === null || !("kind" in error)) {
    return undefined;
  }
  return error.kind === "cancelled" ||
    error.kind === "non-retryable" ||
    error.kind === "retryable"
    ? error.kind
    : undefined;
}

function isNamedAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

export interface WorkflowNode<TInput = unknown, TOutput = unknown> {
  id: string;
  run(input: TInput, context: WorkflowContext): Promise<TOutput>;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  when?: (output: unknown) => boolean;
}

export interface WorkflowDefinition {
  id: string;
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  startNodeId?: string;
}

export function defineNode<TInput, TOutput>(
  node: WorkflowNode<TInput, TOutput>,
): WorkflowNode<TInput, TOutput> {
  if (node.id.length === 0) {
    throw new Error("node id must not be empty");
  }

  return {
    id: node.id,
    async run(input, context) {
      return node.run(input, context);
    },
  };
}

export function defineWorkflow(
  definition: WorkflowDefinition,
): WorkflowDefinition {
  if (definition.id.length === 0) {
    throw new Error("workflow id must not be empty");
  }

  const nodeIds = new Set<string>();
  for (const node of definition.nodes) {
    if (nodeIds.has(node.id)) {
      throw new Error(`duplicate node id: ${node.id}`);
    }
    nodeIds.add(node.id);
  }

  if (
    definition.startNodeId !== undefined &&
    !nodeIds.has(definition.startNodeId)
  ) {
    throw new Error(`start node does not exist: ${definition.startNodeId}`);
  }

  const adjacency = new Map<string, string[]>();
  for (const nodeId of nodeIds) {
    adjacency.set(nodeId, []);
  }

  for (const edge of definition.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      throw new Error(
        `edge endpoint does not exist: ${edge.from} -> ${edge.to}`,
      );
    }
    adjacency.get(edge.from)?.push(edge.to);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): void => {
    if (visiting.has(nodeId)) {
      throw new Error("workflow contains a cycle");
    }
    if (visited.has(nodeId)) {
      return;
    }

    visiting.add(nodeId);
    for (const nextNodeId of adjacency.get(nodeId) ?? []) {
      visit(nextNodeId);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
  };

  for (const nodeId of nodeIds) {
    visit(nodeId);
  }

  return definition;
}
