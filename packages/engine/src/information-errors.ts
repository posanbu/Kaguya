/**
 * 架构说明：本模块集中声明信息原子体系在 engine 层的错误类型，
 * 让 registry、bus、core、Selector 与后续 storage 实现共享同一组可判定异常。
 * 代码库关系：`packages/engine/src/index.ts` 统一导出这里的错误类，
 * 下游在启动、注册、追加与订阅阶段可据此区分可恢复与不可恢复失败。
 */
export class InformationEngineError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class DuplicateInformationKindError extends InformationEngineError {
  constructor(readonly kind: string) {
    super(`Duplicate information kind: ${kind}`);
  }
}

export class UnknownInformationKindError extends InformationEngineError {
  constructor(readonly kind: string) {
    super(`Unknown information kind: ${kind}`);
  }
}

export class ReservedInformationKindError extends InformationEngineError {
  constructor(
    readonly kind: string,
    readonly operation: "register" | "registerBuiltin",
  ) {
    super(`Information kind is reserved for core use: ${kind}`);
  }
}

export class InformationRegistrySealedError extends InformationEngineError {
  constructor() {
    super("Information kind registry has been sealed");
  }
}

export class InvalidInformationIdError extends InformationEngineError {
  constructor(
    readonly informationId: string,
    cause?: unknown,
  ) {
    super(`Invalid information id: ${informationId}`, { cause });
  }
}

export class InformationIdCollisionError extends InformationEngineError {
  constructor(readonly informationId: string) {
    super(`Information id collision: ${informationId}`);
  }
}

export class InformationReferenceValidationError extends InformationEngineError {
  constructor(
    readonly kind: string,
    readonly relation: string,
    readonly reason:
      "undeclared" | "multiple" | "missing-target" | "target-kind" | "required",
  ) {
    super(`Invalid information reference ${relation} on ${kind}: ${reason}`);
  }
}

export class InformationCoreNotStartedError extends InformationEngineError {
  constructor() {
    super("Information core has not been started");
  }
}

export class InformationCoreClosedError extends InformationEngineError {
  constructor() {
    super("Information core has been closed");
  }
}

export class InvalidInformationSelectionError extends InformationEngineError {
  constructor(
    readonly selectorId: string,
    cause?: unknown,
  ) {
    super(`Invalid information selection: ${selectorId}`, { cause });
  }
}

export class SelectorSourceInformationMissingError extends InformationEngineError {
  constructor(
    readonly selectorId: string,
    readonly informationId: string,
  ) {
    super(
      `Selector source information is missing: ${selectorId} -> ${informationId}`,
    );
  }
}

export class DuplicateSelectedInformationIdError extends InformationEngineError {
  constructor(
    readonly selectorId: string,
    readonly informationId: string,
  ) {
    super(
      `Selector returned duplicate information id: ${selectorId} -> ${informationId}`,
    );
  }
}

export class UnknownSelectedInformationIdError extends InformationEngineError {
  constructor(
    readonly selectorId: string,
    readonly informationId: string,
  ) {
    super(
      `Selector returned unknown information id: ${selectorId} -> ${informationId}`,
    );
  }
}

export class UnauthorizedSelectedInformationIdError extends InformationEngineError {
  constructor(
    readonly selectorId: string,
    readonly informationId: string,
  ) {
    super(
      `Selector returned unauthorized information id: ${selectorId} -> ${informationId}`,
    );
  }
}

export class SelectedInformationMissingError extends InformationEngineError {
  constructor(
    readonly selectorId: string,
    readonly informationId: string,
  ) {
    super(
      `Selected information disappeared during load: ${selectorId} -> ${informationId}`,
    );
  }
}

export class InvalidSelectorQueryError extends InformationEngineError {
  constructor(
    readonly selectorId: string,
    readonly operation: "find" | "related" | "retrieve",
    cause?: unknown,
  ) {
    super(`Invalid selector query: ${selectorId} -> ${operation}`, { cause });
  }
}

export class UnknownRetrievalStrategyError extends InformationEngineError {
  constructor(
    readonly selectorId: string,
    readonly strategyId: string,
  ) {
    super(
      `Unknown information retrieval strategy: ${selectorId} -> ${strategyId}`,
    );
  }
}
