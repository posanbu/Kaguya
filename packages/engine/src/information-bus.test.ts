/**
 * 架构说明：本测试覆盖信息 atom bus 的快照隔离、typed consumer 结果与失败隔离，
 * 以保证发布阶段不会把可变对象引用泄漏给观察者或吞掉失败归属。
 * 代码库关系：`InformationCore` 依赖这里的发布语义完成“先持久化、后广播”，
 * 因此 bus 的行为必须独立可测并与存储层解耦。
 */
import { freezeInformationAtom, informationIdSchema, z } from "@kaguya/schema";
import { defineInformationKind } from "@kaguya/sdk";
import { describe, expect, it } from "vitest";

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
  it("returns each typed consumer outcome while isolating failures", async () => {
    const order: string[] = [];
    const bus = new InformationBus();

    bus.on(messageDefinition.kind, { consumerId: "first" }, () => {
      order.push("first");
    });
    bus.on(messageDefinition.kind, { consumerId: "second" }, () => {
      order.push("second");
      throw new Error("observer failed");
    });
    bus.onAll({ consumerId: "all" }, () => {
      order.push("all");
    });

    const results = await bus.publish(atom);

    expect(new Set(order)).toEqual(new Set(["first", "second", "all"]));
    expect(results).toHaveLength(3);
    expect(results).toEqual(
      expect.arrayContaining([
        { consumer: { consumerId: "first" }, status: "fulfilled" },
        {
          consumer: { consumerId: "second" },
          status: "rejected",
          reason: expect.objectContaining({ message: "observer failed" }),
        },
        { consumer: { consumerId: "all" }, status: "fulfilled" },
      ]),
    );
  });

  it("returns a frozen snapshot that cannot be mutated by observers", async () => {
    const bus = new InformationBus();
    const seen: Array<unknown> = [];

    bus.on(messageDefinition.kind, { consumerId: "observer" }, (candidate) => {
      seen.push(candidate);
    });

    await bus.publish(atom);

    expect(seen).toHaveLength(1);
    expect(Object.isFrozen(seen[0] as object)).toBe(true);
    expect(Object.isFrozen((seen[0] as { payload: object }).payload)).toBe(
      true,
    );
    expect(atom.payload.text).toBe("moon");
  });
});
