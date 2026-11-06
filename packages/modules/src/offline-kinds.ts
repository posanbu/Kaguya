/**
 * 功能概述：为离线升级公开一方模块的静态 Kind 声明，包括兼容读取的历史版本。
 * 主要职责：offlineFirstPartyKinds 只收集显式导入领域中已构造的 Kind 对象，不调用模块工厂或启动钩子。
 * 代码库关系：Server 离线入口合并 Runtime 内建与 MCP 延迟结果声明；在线 Catalog 继续保持原实现。
 * 输入输出与副作用：无配置读取、计时器、连接或模型调用；同名异对象在组合边界必须报错。
 */
import type { InformationKindDefinition } from "@kaguya/sdk";
import * as domain0 from "./first-party/kinds/message.js";
import * as domain1 from "./first-party/kinds/turn.js";
import * as domain2 from "./first-party/kinds/heartbeat.js";
import * as domain3 from "./first-party/kinds/identity.js";
import * as domain4 from "./first-party/lifecycle/activity.js";
import * as domain5 from "./first-party/lifecycle/pulse.js";
import * as domain6 from "./first-party/memory-native/facts.js";
import * as domain7 from "./first-party/message-authorization.js";
import * as domain8 from "./first-party/observation.js";
import * as domain9 from "./first-party/qq-expression/facts.js";
import * as domain10 from "./first-party/router/focus-facts.js";
import * as domain11 from "./first-party/router/light.js";
import * as domain12 from "./first-party/router/raw-context.js";
import * as domain13 from "./first-party/situation-runtime.js";
import * as domain14 from "./first-party/heavy/recall.js";
import * as domain15 from "./first-party/heavy/speech.js";

export const offlineFirstPartyKinds = Object.freeze(
  [
    domain0,
    domain1,
    domain2,
    domain3,
    domain4,
    domain5,
    domain6,
    domain7,
    domain8,
    domain9,
    domain10,
    domain11,
    domain12,
    domain13,
    domain14,
    domain15,
  ].flatMap((domain) =>
    Object.values(domain as Record<string, unknown>).filter(
      (value): value is InformationKindDefinition<string, any> =>
        value !== null &&
        typeof value === "object" &&
        "kind" in value &&
        "payloadSchema" in value &&
        "references" in value &&
        "log" in value,
    ),
  ),
);
