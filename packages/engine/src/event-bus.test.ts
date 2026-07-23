import type { EventEnvelope } from "@kaguya/schema";
import { describe, expect, it, vi } from "vitest";

import { EventBus } from "./event-bus.js";

const messageEvent: EventEnvelope<"message.received", { text: string }> = {
  id: "event-1",
  type: "message.received",
  source: "test",
  occurredAt: "2026-07-23T00:00:00.000Z",
  traceId: "trace-1",
  sessionId: "session-1",
  payload: { text: "original" },
  metadata: { source: "caller" },
};

describe("EventBus", () => {
  it("runs interceptors by descending priority and stops on interruption", async () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.subscribe(
      "message.received",
      async (event) => {
        order.push("low");
        return { continue: true, event };
      },
      { name: "low", priority: 0, mode: "intercept" },
    );
    bus.subscribe(
      "message.received",
      async (event) => {
        order.push("high");
        return { continue: false, event };
      },
      { name: "high", priority: 10, mode: "intercept" },
    );

    const result = await bus.emit(messageEvent);

    expect(order).toEqual(["high"]);
    expect(result.continue).toBe(false);
  });

  it("passes interceptor mutations onward without mutating the caller event", async () => {
    const bus = new EventBus();
    bus.subscribe(
      "message.received",
      (event) => {
        event.payload.text = "changed";
        event.metadata.handled = true;
        return { continue: true, event };
      },
      { mode: "intercept" },
    );

    const result = await bus.emit(messageEvent);

    expect(result.event.payload.text).toBe("changed");
    expect(result.event.metadata.handled).toBe(true);
    expect(messageEvent).toMatchObject({
      payload: { text: "original" },
      metadata: { source: "caller" },
    });
  });

  it("does not let an interceptor mutate a caller array payload", async () => {
    const bus = new EventBus();
    const arrayEvent: EventEnvelope<"message.received", string[]> = {
      ...messageEvent,
      payload: ["original"],
    };
    bus.subscribe(
      "message.received",
      (event) => {
        (event.payload as unknown as string[]).push("interceptor mutation");
        return { continue: true, event };
      },
      { mode: "intercept" },
    );

    const result = await bus.emit(arrayEvent);

    expect(result.event.payload).toEqual(["original", "interceptor mutation"]);
    expect(arrayEvent.payload).toEqual(["original"]);
  });

  it("isolates observer failures and mutations from the business result", async () => {
    const onObserverError = vi.fn();
    const bus = new EventBus({ onObserverError });
    bus.subscribe(
      "message.received",
      (event) => {
        event.payload.text = "observed mutation";
        throw new Error("observer failed");
      },
      { mode: "observe" },
    );

    const result = await bus.emit(messageEvent);

    expect(result).toMatchObject({
      continue: true,
      event: { payload: { text: "original" } },
    });
    expect(onObserverError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "observer failed" }),
    );
  });

  it("deeply isolates observer payload and metadata mutations", async () => {
    const bus = new EventBus();
    const nestedEvent: EventEnvelope<
      "message.received",
      { message: { text: string } }
    > = {
      ...messageEvent,
      payload: { message: { text: "original" } },
      metadata: { audit: { source: "caller" } },
    };
    bus.subscribe(
      "message.received",
      (event) => {
        const payload = event.payload as { message: { text: string } };
        const audit = event.metadata.audit as { source: string };
        payload.message.text = "observer mutation";
        audit.source = "observer";
      },
      { mode: "observe" },
    );

    const result = await bus.emit(nestedEvent);

    expect(result.event).toMatchObject({
      payload: { message: { text: "original" } },
      metadata: { audit: { source: "caller" } },
    });
    expect(nestedEvent).toMatchObject({
      payload: { message: { text: "original" } },
      metadata: { audit: { source: "caller" } },
    });
  });

  it("rejects uncloneable event data with a typed clone error", async () => {
    const bus = new EventBus();
    const uncloneableEvent: EventEnvelope<
      "message.received",
      { callback: () => void }
    > = {
      ...messageEvent,
      payload: { callback: () => undefined },
    };

    await expect(bus.emit(uncloneableEvent)).rejects.toMatchObject({
      name: "EventCloneError",
      eventType: "message.received",
      field: "payload",
    });
  });

  it("validates the initial envelope before interceptors, observers, or cloning", async () => {
    const interceptor = vi.fn((event) => ({ continue: true, event }));
    const observer = vi.fn();
    const bus = new EventBus();
    bus.subscribe("message.received", interceptor, { mode: "intercept" });
    bus.subscribe("message.received", observer, { mode: "observe" });
    const malformedEvent = {
      ...messageEvent,
      source: "",
      payload: { callback: () => undefined },
    };

    await expect(bus.emit(malformedEvent)).rejects.toMatchObject({
      name: "EventValidationError",
      eventType: "message.received",
      cause: expect.anything(),
    });
    expect(interceptor).not.toHaveBeenCalled();
    expect(observer).not.toHaveBeenCalled();
  });

  it("validates an interceptor rewrite before the next handler or observer", async () => {
    const nextInterceptor = vi.fn((event) => ({ continue: true, event }));
    const observer = vi.fn();
    const bus = new EventBus();
    bus.subscribe(
      "message.received",
      (event) => ({
        continue: true,
        event: { ...event, occurredAt: "not-an-iso-datetime" },
      }),
      { priority: 10, mode: "intercept" },
    );
    bus.subscribe("message.received", nextInterceptor, {
      priority: 0,
      mode: "intercept",
    });
    bus.subscribe("message.received", observer, { mode: "observe" });

    await expect(bus.emit(messageEvent)).rejects.toMatchObject({
      name: "EventValidationError",
      eventType: "message.received",
      cause: expect.anything(),
    });
    expect(nextInterceptor).not.toHaveBeenCalled();
    expect(observer).not.toHaveBeenCalled();
  });
});
