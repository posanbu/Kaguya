/**
 * 功能概述：验证 Router 在旧 scope 碰撞的长历史中仍按完整 scene 分页读取。
 * 主要职责：合成账本模拟正序排他 cursor 与倒序包含 cursor，断言越过整页外场景事实并去除页边界重复。
 * 代码库关系：直接调用 scene-query 的 findSceneFacts；完整 Core 授权、持久调度和终态由 index.test.ts 验证。
 * 输入输出与副作用：纯内存来源和固定时间，不访问数据库、模型或平台；不改变生产分页上限。
 */
import { expect, it, vi } from "vitest";
import {
  freezeInformationAtom,
  informationIdSchema,
  legacyHeartbeatScope,
  type SceneAddress,
} from "@kaguya/schema";
import type { InformationSelectorLedger } from "@kaguya/sdk";
import { findSceneFacts } from "./scene-query.js";

it.each(["asc", "desc"] as const)(
  "finds scene facts beyond a colliding full page in %s order",
  async (order) => {
    const own: SceneAddress = {
      platform: "a:b",
      adapterId: "c",
      destination: { kind: "group", groupId: "d" },
    };
    const foreign: SceneAddress = {
      platform: "a",
      adapterId: "b:c",
      destination: { kind: "group", groupId: "d" },
    };
    expect(legacyHeartbeatScope(own)).toBe(legacyHeartbeatScope(foreign));
    const facts = Array.from({ length: 1002 }, (_, index) =>
      freezeInformationAtom({
        informationId: informationIdSchema.parse(`scene-fact-${index}`),
        kind: "test.scene.fact",
        occurredAt: "2026-11-07T00:00:00.000Z",
        source: "test:scene",
        payload: { source: { ...(index < 1000 ? foreign : own) } },
        references: [],
      }),
    );
    const find = vi.fn<InformationSelectorLedger["find"]>(async (query) => {
      const cursor = query.afterInformationId ?? query.throughInformationId;
      const position = cursor
        ? facts.findIndex((atom) => atom.informationId === cursor)
        : 0;
      expect(position).toBeGreaterThanOrEqual(0);
      const start = position + (query.afterInformationId ? 1 : 0);
      return facts.slice(start, start + query.limit!);
    });
    const result = await findSceneFacts(
      { find } as unknown as InformationSelectorLedger,
      own,
      {
        kinds: ["test.scene.fact"],
        scopeKey: legacyHeartbeatScope(own),
        order,
        limit: 2,
      },
    );
    expect(result.map((atom) => atom.informationId)).toEqual([
      "scene-fact-1000",
      "scene-fact-1001",
    ]);
    expect(find).toHaveBeenCalledTimes(2);
    expect(find.mock.calls[1]![0]).toMatchObject({
      limit: 1000,
      registrationOrder: true,
      ...(order === "asc"
        ? { afterInformationId: "scene-fact-999" }
        : { throughInformationId: "scene-fact-999" }),
    });
  },
);
