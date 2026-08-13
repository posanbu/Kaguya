import { describe, expect, it } from "vitest";

import * as events from "./events.js";

const approvedEventTypes = [
  "message.received",
  "message.persisted",
  "message.ingested",
  "heartbeat.tick",
  "memory.schedule.tick",
  "memory.session.tick",
  "route.requested",
  "route.decided",
  "prompt.compiled",
  "llm.requested",
  "llm.completed",
  "llm.failed",
  "memory.write.requested",
  "memory.written",
  "reply.generated",
  "reply.requested",
] as const;

describe("runtime event catalog", () => {
  it("exports every approved concrete event as an EventDefinition", () => {
    const catalog = (
      events as unknown as {
        approvedEventDefinitions?: ReadonlyArray<{
          type: string;
          payloadSchema: unknown;
          create: unknown;
        }>;
      }
    ).approvedEventDefinitions;

    expect(catalog).toBeDefined();
    expect(catalog?.map((definition) => definition.type)).toEqual(
      approvedEventTypes,
    );
    expect(
      catalog?.every(
        (definition) =>
          definition.payloadSchema !== undefined &&
          typeof definition.create === "function",
      ),
    ).toBe(true);
  });
});
