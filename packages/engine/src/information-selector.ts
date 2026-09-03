/**
 * 功能概述：在 Core 内执行 Information Selector，并为每次调用建立独立的只读授权作用域。
 * 主要职责：校验 Selector 输出、阻止重复/未知/越权 ID、按选择顺序重新加载原子，
 * 并提供受约束的 find、单跳引用遍历与命名检索读取。
 * 代码库关系：`InformationCore` 持有本执行器；SDK 只暴露 reader 契约，真实
 * `InformationLedger` 与检索策略不会泄漏给业务模块。
 * 输入输出与副作用：只读取账本，不写入原子；每次 `select` 新建 Set，授权不会跨并发
 * 调用共享；返回数组被冻结且严格保留 Selector 给出的 ID 顺序。
 */
import {
  informationIdSchema,
  jsonObjectSchema,
  type DeepReadonly,
  type InformationAtom,
  type InformationId,
  type JsonObject,
  z,
} from "@kaguya/schema";
import type {
  InformationFindQuery,
  InformationRelatedQuery,
  InformationRetrievalQuery,
  InformationSelectorDefinition,
  InformationSelectorLedger,
} from "@kaguya/sdk";

import type { InformationLedger } from "./information-core.js";
import {
  DuplicateSelectedInformationIdError,
  InformationEngineError,
  InvalidInformationSelectionError,
  InvalidSelectorQueryError,
  SelectedInformationMissingError,
  SelectorSourceInformationMissingError,
  UnauthorizedSelectedInformationIdError,
  UnknownRetrievalStrategyError,
  UnknownSelectedInformationIdError,
} from "./information-errors.js";

export interface InformationRetrievalStrategy {
  readonly strategyId: string;
  retrieve(input: {
    readonly input: JsonObject;
    readonly limit: number;
  }): Promise<readonly InformationId[]>;
}

const limitSchema = z.number().int().min(1).max(1_000);
const findSchema = z
  .object({
    kinds: z.array(z.string().trim().min(1)).min(1).optional(),
    sources: z.array(z.string().trim().min(1)).min(1).optional(),
    occurredAfter: z.iso.datetime({ offset: true }).optional(),
    occurredBefore: z.iso.datetime({ offset: true }).optional(),
    limit: limitSchema,
  })
  .strict()
  .refine(
    ({ kinds, sources, occurredAfter, occurredBefore }) =>
      kinds !== undefined ||
      sources !== undefined ||
      occurredAfter !== undefined ||
      occurredBefore !== undefined,
    "selector find query must include a filter",
  )
  .refine(
    ({ occurredAfter, occurredBefore }) =>
      occurredAfter === undefined ||
      occurredBefore === undefined ||
      Date.parse(occurredAfter) < Date.parse(occurredBefore),
    "selector find query time range must be increasing",
  );

const relatedSchema = z
  .object({
    from: z.array(informationIdSchema).min(1),
    relation: z.string().trim().min(1).optional(),
    direction: z.enum(["outgoing", "incoming"]),
    limit: limitSchema,
  })
  .strict();

const retrievalSchema = z
  .object({
    strategyId: z.string().trim().min(1),
    input: jsonObjectSchema,
    limit: limitSchema,
  })
  .strict();

export class InformationSelectorExecutor {
  readonly #strategies: ReadonlyMap<string, InformationRetrievalStrategy>;

  constructor(
    private readonly ledger: InformationLedger,
    strategies: readonly InformationRetrievalStrategy[] = [],
  ) {
    const byId = new Map<string, InformationRetrievalStrategy>();
    for (const strategy of strategies) {
      const strategyId = strategy.strategyId.trim();
      if (strategyId.length === 0) {
        throw new Error("information retrieval strategy id must not be blank");
      }
      if (byId.has(strategyId)) {
        throw new Error(
          `Duplicate information retrieval strategy: ${strategyId}`,
        );
      }
      byId.set(strategyId, strategy);
    }
    this.#strategies = byId;
  }

  async select(
    selector: InformationSelectorDefinition,
    sourceInformationId: InformationId,
  ): Promise<readonly DeepReadonly<InformationAtom>[]> {
    const sourceAtom = await this.ledger.get(sourceInformationId);
    if (sourceAtom === undefined) {
      throw new SelectorSourceInformationMissingError(
        selector.selectorId,
        sourceInformationId,
      );
    }

    const scope = new SelectorReadScope(
      selector.selectorId,
      this.ledger,
      this.#strategies,
      sourceAtom,
    );
    let raw: unknown;
    try {
      raw = await selector.select({ sourceAtom, ledger: scope.reader });
    } catch (cause) {
      if (cause instanceof InformationEngineError) {
        throw cause;
      }
      throw new InvalidInformationSelectionError(selector.selectorId, cause);
    }
    const ids = parseSelection(selector.selectorId, raw);
    assertUnique(selector.selectorId, ids);

    const firstLoad = indexById(await this.ledger.getMany(ids));
    for (const id of ids) {
      if (!firstLoad.has(id)) {
        throw new UnknownSelectedInformationIdError(selector.selectorId, id);
      }
      if (!scope.isAuthorized(id)) {
        throw new UnauthorizedSelectedInformationIdError(
          selector.selectorId,
          id,
        );
      }
    }

    const finalLoad = indexById(await this.ledger.getMany(ids));
    return Object.freeze(
      ids.map((id) => {
        const atom = finalLoad.get(id);
        if (atom === undefined) {
          throw new SelectedInformationMissingError(selector.selectorId, id);
        }
        return atom;
      }),
    );
  }
}

class SelectorReadScope {
  readonly #authorized = new Map<
    InformationId,
    DeepReadonly<InformationAtom>
  >();
  readonly reader: InformationSelectorLedger;

  constructor(
    private readonly selectorId: string,
    private readonly ledger: InformationLedger,
    private readonly strategies: ReadonlyMap<
      string,
      InformationRetrievalStrategy
    >,
    sourceAtom: DeepReadonly<InformationAtom>,
  ) {
    this.authorize([sourceAtom]);
    this.reader = Object.freeze({
      find: (query: InformationFindQuery) => this.find(query),
      related: (query: InformationRelatedQuery) => this.related(query),
      retrieve: (query: InformationRetrievalQuery) => this.retrieve(query),
    });
  }

  isAuthorized(informationId: InformationId): boolean {
    return this.#authorized.has(informationId);
  }

  private async find(
    query: InformationFindQuery,
  ): Promise<readonly DeepReadonly<InformationAtom>[]> {
    const parsed = findSchema.safeParse(query);
    if (!parsed.success) {
      throw new InvalidSelectorQueryError(
        this.selectorId,
        "find",
        parsed.error,
      );
    }
    const atoms = stableUniqueAtoms(await this.ledger.find(parsed.data)).slice(
      0,
      parsed.data.limit,
    );
    this.authorize(atoms);
    return Object.freeze(atoms);
  }

  private async related(
    query: InformationRelatedQuery,
  ): Promise<readonly DeepReadonly<InformationAtom>[]> {
    const parsed = relatedSchema.safeParse(query);
    if (!parsed.success) {
      throw new InvalidSelectorQueryError(
        this.selectorId,
        "related",
        parsed.error,
      );
    }
    if (new Set(parsed.data.from).size !== parsed.data.from.length) {
      throw new InvalidSelectorQueryError(
        this.selectorId,
        "related",
        new Error("related start ids must be unique"),
      );
    }
    for (const informationId of parsed.data.from) {
      if (!this.#authorized.has(informationId)) {
        throw new UnauthorizedSelectedInformationIdError(
          this.selectorId,
          informationId,
        );
      }
    }

    const atoms =
      parsed.data.direction === "outgoing"
        ? await this.loadOutgoing(parsed.data)
        : await this.loadIncoming(parsed.data);
    this.authorize(atoms);
    return Object.freeze(atoms);
  }

  private async retrieve(
    query: InformationRetrievalQuery,
  ): Promise<readonly DeepReadonly<InformationAtom>[]> {
    const parsed = retrievalSchema.safeParse(query);
    if (!parsed.success) {
      throw new InvalidSelectorQueryError(
        this.selectorId,
        "retrieve",
        parsed.error,
      );
    }
    const strategy = this.strategies.get(parsed.data.strategyId);
    if (strategy === undefined) {
      throw new UnknownRetrievalStrategyError(
        this.selectorId,
        parsed.data.strategyId,
      );
    }
    const rawIds = await strategy.retrieve({
      input: parsed.data.input,
      limit: parsed.data.limit,
    });
    const ids = stableUniqueIds(
      parseRetrievedIds(this.selectorId, rawIds),
    ).slice(0, parsed.data.limit);
    const byId = indexById(await this.ledger.getMany(ids));
    const atoms = ids.map((informationId) => {
      const atom = byId.get(informationId);
      if (atom === undefined) {
        throw new UnknownSelectedInformationIdError(
          this.selectorId,
          informationId,
        );
      }
      return atom;
    });
    this.authorize(atoms);
    return Object.freeze(atoms);
  }

  private async loadOutgoing(query: {
    readonly from: readonly InformationId[];
    readonly relation?: string;
    readonly limit: number;
  }): Promise<DeepReadonly<InformationAtom>[]> {
    const targetIds = stableUniqueIds(
      query.from.flatMap((informationId) => {
        const atom = this.#authorized.get(informationId)!;
        return atom.references
          .filter(
            (reference) =>
              query.relation === undefined ||
              reference.relation === query.relation,
          )
          .map((reference) => reference.informationId);
      }),
    ).slice(0, query.limit);
    const byId = indexById(await this.ledger.getMany(targetIds));
    return targetIds.map((informationId) => {
      const atom = byId.get(informationId);
      if (atom === undefined) {
        throw new SelectedInformationMissingError(
          this.selectorId,
          informationId,
        );
      }
      return atom;
    });
  }

  private async loadIncoming(query: {
    readonly from: readonly InformationId[];
    readonly relation?: string;
    readonly limit: number;
  }): Promise<DeepReadonly<InformationAtom>[]> {
    const atoms: DeepReadonly<InformationAtom>[] = [];
    for (const informationId of query.from) {
      atoms.push(
        ...(await this.ledger.query({
          informationId,
          ...(query.relation === undefined ? {} : { relation: query.relation }),
        })),
      );
    }
    return stableUniqueAtoms(atoms).slice(0, query.limit);
  }

  private authorize(atoms: readonly DeepReadonly<InformationAtom>[]): void {
    for (const atom of atoms) {
      this.#authorized.set(atom.informationId, atom);
    }
  }
}

function parseSelection(
  selectorId: string,
  value: unknown,
): readonly InformationId[] {
  const parsed = z.array(informationIdSchema).safeParse(value);
  if (!parsed.success) {
    throw new InvalidInformationSelectionError(selectorId, parsed.error);
  }
  return Object.freeze([...parsed.data]);
}

function assertUnique(
  selectorId: string,
  informationIds: readonly InformationId[],
): void {
  const seen = new Set<InformationId>();
  for (const informationId of informationIds) {
    if (seen.has(informationId)) {
      throw new DuplicateSelectedInformationIdError(selectorId, informationId);
    }
    seen.add(informationId);
  }
}

function indexById(
  atoms: readonly DeepReadonly<InformationAtom>[],
): ReadonlyMap<InformationId, DeepReadonly<InformationAtom>> {
  return new Map(atoms.map((atom) => [atom.informationId, atom] as const));
}

function stableUniqueAtoms(
  atoms: readonly DeepReadonly<InformationAtom>[],
): DeepReadonly<InformationAtom>[] {
  const seen = new Set<InformationId>();
  return atoms.filter((atom) => {
    if (seen.has(atom.informationId)) {
      return false;
    }
    seen.add(atom.informationId);
    return true;
  });
}

function parseRetrievedIds(
  selectorId: string,
  value: unknown,
): readonly InformationId[] {
  const parsed = z.array(informationIdSchema).safeParse(value);
  if (!parsed.success) {
    throw new InvalidInformationSelectionError(selectorId, parsed.error);
  }
  return parsed.data;
}

function stableUniqueIds(
  informationIds: readonly InformationId[],
): InformationId[] {
  return [...new Set(informationIds)];
}
