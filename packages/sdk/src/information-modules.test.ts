/**
 * 功能概述：本文件验证信息模块 SDK 的最小公开订阅契约，防止旧的定向路由 API
 * 重新暴露到模块作者。
 * 主要职责：验证 `onInformation` 保存传入 definition，并让 handler 通过
 * `InformationModuleHandlerContext.register` 注册派生 atom；同时验证模块清单拒绝
 * 重复 kind，并断言 `onTargetedInformation` 不再导出。
 * 代码库关系：测试最终 `modules.ts` 及其经由 `index.ts` 的 SDK 出口；
 * engine `ModuleHost` 依赖同一 subscription definition 把消费者注册到 Core。
 * 输入输出与副作用：只构造内存中的 kind 和模块定义，不访问持久化或 Runtime；
 * 类型检查会确保 handler context 的公开方法保持为 `register`。
 */
import { z } from "@kaguya/schema";
import { describe, expect, it } from "vitest";

import * as informationModules from "./modules.js";
import * as sdk from "./index.js";
import {
  defineInformationKind,
  defineInformationModule,
  onInformation,
} from "./index.js";

const inputKind = defineInformationKind({
  kind: "acme.sdk.input",
  payloadSchema: z.object({ text: z.string() }).strict(),
  references: {},
  log: { enabled: false },
});

const outputKind = defineInformationKind({
  kind: "acme.sdk.output",
  payloadSchema: z.object({ text: z.string() }).strict(),
  references: {},
  log: { enabled: false },
});

describe("information module SDK", () => {
  it("defines non-targeted subscriptions that register derived atoms", () => {
    const subscription = onInformation(inputKind, async (atom, context) => {
      await context.register(outputKind, {
        payload: { text: atom.payload.text },
      });
    });

    expect(subscription).toMatchObject({
      kind: inputKind.kind,
      definition: inputKind,
    });
    expect(subscription).not.toHaveProperty("targeted");
    expect(informationModules).not.toHaveProperty("onTargetedInformation");
    expect(sdk).not.toHaveProperty("onTargetedInformation");
  });

  it("rejects duplicate declared kinds", () => {
    expect(() =>
      defineInformationModule({
        manifest: {
          apiVersion: 1,
          definitionId: "acme.duplicate",
          displayName: "Duplicate",
          settingsSchema: z.object({}).strict(),
          informationKinds: [inputKind, inputKind],
        },
        create: () => ({ subscriptions: [] }),
      }),
    ).toThrow(`Duplicate information module kind: ${inputKind.kind}`);
  });
});
