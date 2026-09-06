/**
 * 功能概述：验证 SDK 包入口只公开信息原子模块所需的可执行定义能力。
 * 主要职责：通过公共入口创建 kind、模块和订阅，确认设置解析与订阅 definition 身份
 * 能被最终 `ModuleHost` 直接消费。
 * 代码库关系：测试 `index.ts` 对 `information-kind.ts` 与 `modules.ts` 的聚合；更细的
 * kind 递归 schema 和模块订阅约束分别由同包专项测试覆盖。
 * 输入输出与副作用：仅构造内存 definition，不启动 Core 或访问数据库。
 */
import { z } from "@kaguya/schema";
import { describe, expect, it } from "vitest";

import {
  defineInformationKind,
  defineInformationModule,
  onInformation,
} from "./index.js";

describe("information module SDK public entry", () => {
  it("creates a typed subscription from the final package entry", async () => {
    const input = defineInformationKind({
      kind: "acme.sdk.input",
      payloadSchema: z.object({ text: z.string() }).strict(),
      references: {},
      log: { enabled: false },
    });
    const definition = defineInformationModule({
      manifest: {
        apiVersion: 1,
        definitionId: "acme.sdk.module",
        displayName: "SDK module",
        settingsSchema: z.object({}).strict(),
        informationKinds: [input],
      },
      create: () => ({
        subscriptions: [onInformation(input, () => undefined)],
      }),
    });

    const instance = await definition.create({
      instanceId: "sdk.default",
      settings: {},
    });

    expect(instance.subscriptions).toEqual([
      expect.objectContaining({ kind: input.kind, definition: input }),
    ]);
  });
});
