/**
 * 功能概述：验证外部插件的版本化 Kind 与兼容读取契约。
 * 主要职责：覆盖版本身份、声明冻结、旧 Atom 只读转换和非法声明；不访问网络或数据库。
 * 代码库关系：module-plugin.ts 提供插件公共 API，Composition 与数据库复用其元数据。
 */
import { expect, it } from "vitest";
import { z } from "@kaguya/schema";
import {
  defineVersionedInformationKind,
  readCompatibleInformation,
} from "./module-plugin.js";

const old = () =>
  defineVersionedInformationKind({
    owner: "example.sensor",
    version: 1,
    kind: "example.temperature.v1",
    displayName: "温度",
    description: "温度观测",
    payloadSchema: z.strictObject({ celsius: z.number() }),
    references: {},
    log: { enabled: false },
  });
it("retains immutable version identity and converts only a read projection", () => {
  const v1 = old();
  const v2 = defineVersionedInformationKind({
    owner: "example.sensor",
    version: 2,
    kind: "example.temperature.v2",
    displayName: "温度",
    description: "温度观测",
    payloadSchema: z.strictObject({ kelvin: z.number() }),
    references: {},
    log: { enabled: false },
  });
  const atom = Object.freeze({
    informationId: "observation-old",
    kind: v1.kind,
    occurredAt: "2026-09-28T00:00:00.000Z",
    source: "test",
    payload: Object.freeze({ celsius: 20 }),
    references: [],
  });
  const projected = readCompatibleInformation(atom, v2, [
    { from: v1, convert: (payload) => ({ kelvin: payload.celsius + 273.15 }) },
  ]);
  expect(projected).toEqual({ kelvin: 293.15 });
  expect(atom.payload).toEqual({ celsius: 20 });
  expect(v1.persistence).toMatchObject({ owner: "example.sensor", version: 1 });
  expect(Object.isFrozen(v1.persistence)).toBe(true);
  expect(() => readCompatibleInformation(atom, v2, [])).toThrow(
    "Unsupported information kind version",
  );
});
it("rejects reusing an unversioned or mismatched kind name", () => {
  expect(() =>
    defineVersionedInformationKind({
      ...old(),
      owner: "example.sensor",
      version: 2,
    }),
  ).toThrow("version suffix");
});
