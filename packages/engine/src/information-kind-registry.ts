/**
 * 架构说明：本模块实现信息 kind registry 的封锁生命周期，
 * 负责区分 Engine 内建 kind 与业务自定义 kind，并在 Core 启动前冻结注册表。
 * 代码库关系：`InformationCore` 构造时在此注册 `consumer.failed`，`start()` 依赖
 * 这里的定义快照同步到存储层，
 * 而 `packages/engine/src/index.ts` 将 Registry 作为 engine 公共入口导出。
 */
import type { JsonObject } from "@kaguya/schema";
import type { InformationKindDefinition } from "@kaguya/sdk";

import {
  DuplicateInformationKindError,
  InformationRegistrySealedError,
  ReservedInformationKindError,
  UnknownInformationKindError,
} from "./information-errors.js";

export {
  DuplicateInformationKindError,
  InformationRegistrySealedError,
  ReservedInformationKindError,
  UnknownInformationKindError,
} from "./information-errors.js";

type RegisteredInformationKind = InformationKindDefinition<string, any>;

const coreKindPattern = /^core\.[a-z][a-z0-9._-]*(?:\.[a-z][a-z0-9._-]*)*$/u;

export class InformationKindRegistry {
  #definitions = new Map<string, RegisteredInformationKind>();
  #sealed = false;

  register(definition: RegisteredInformationKind): void {
    this.assertWritable("register");
    this.assertCustomKind(definition.kind, "register");
    this.add(definition);
  }

  registerBuiltin(definition: RegisteredInformationKind): void {
    this.assertWritable("registerBuiltin");
    if (!this.isBuiltinKind(definition.kind)) {
      throw new ReservedInformationKindError(
        definition.kind,
        "registerBuiltin",
      );
    }
    this.add(definition);
  }

  seal(): void {
    this.#sealed = true;
  }

  get(kind: string): RegisteredInformationKind {
    const definition = this.#definitions.get(kind);
    if (definition === undefined) {
      throw new UnknownInformationKindError(kind);
    }
    return definition;
  }

  definitions(): readonly RegisteredInformationKind[] {
    return Object.freeze([...this.#definitions.values()]);
  }

  has(kind: string): boolean {
    return this.#definitions.has(kind);
  }

  assertRegistered(
    definition: RegisteredInformationKind,
  ): RegisteredInformationKind {
    return this.get(definition.kind);
  }

  private add(definition: RegisteredInformationKind): void {
    if (this.#definitions.has(definition.kind)) {
      throw new DuplicateInformationKindError(definition.kind);
    }
    this.#definitions.set(definition.kind, definition);
  }

  private assertWritable(operation: "register" | "registerBuiltin"): void {
    if (this.#sealed) {
      throw new InformationRegistrySealedError();
    }
  }

  private assertCustomKind(
    kind: string,
    operation: "register" | "registerBuiltin",
  ): void {
    if (this.isBuiltinKind(kind)) {
      throw new ReservedInformationKindError(kind, operation);
    }
  }

  private isBuiltinKind(kind: string): boolean {
    return coreKindPattern.test(kind) || kind === "consumer.failed";
  }
}
