/**
 * 架构说明：本测试覆盖信息 atom bus 的快照隔离、订阅顺序与错误汇报，
 * 以保证发布阶段不会把可变对象引用泄漏给观察者。
 * 代码库关系：`InformationCore` 依赖这里的发布语义完成“先持久化、后广播”，
 * 因此 bus 的行为必须独立可测并与存储层解耦。
 */
import { freezeInformationAtom, informationIdSchema, z } from "@kaguya/schema";
import { defineInformationKind } from "@kaguya/sdk";
import { describe, expect, it, vi } from "vitest";

import { InformationBus } from "./information-bus.js";

const messageDefinition = defineInformationKind({
  kind: "acme.message.created",
  payloadSchema: z.object({ text: z.string() }).strict(),
  references: {},
  log: { enabled: false },
});

const atom = freezeInformationAtom({
  informationId: informationIdSchema.parse("atom-1"),
  kind: messageDefinition.kind,
  occurredAt: "2026-09-01T00:00:00.000Z",
  source: "module:acme",
  payload: { text: "moon" },
  references: [],
});

describe("InformationBus", () => {
  it("delivers same-kind subscribers in registration order and isolates failures", async () => {
    const order: string[] = [];
    const onSubscriberError = vi.fn();
    const bus = new InformationBus({ onSubscriberError });

    bus.subscribe(messageDefinition.kind, () => {
      order.push("first");
    });
    bus.subscribe(messageDefinition.kind, () => {
      order.push("second");
      throw new Error("observer failed");
    });
    bus.subscribeAll(() => {
      order.push("all");
    });

    const published = await bus.publish(atom);

    expect(order).toEqual(["first", "second", "all"]);
    expect(onSubscriberError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "observer failed" }),
    );
    expect(Object.isFrozen(published)).toBe(true);
    expect(Object.getPrototypeOf(published.payload)).toBe(Object.prototype);
  });

  it("returns a frozen snapshot that cannot be mutated by observers", async () => {
    const bus = new InformationBus();
    const seen: Array<unknown> = [];

    bus.subscribe(messageDefinition.kind, (candidate) => {
      seen.push(candidate);
    });

    const published = await bus.publish(atom);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(published);
    expect(Object.isFrozen(seen[0] as object)).toBe(true);
    expect(Object.isFrozen((published as { payload: object }).payload)).toBe(true);
    expect(atom.payload.text).toBe("moon");
  });
});
