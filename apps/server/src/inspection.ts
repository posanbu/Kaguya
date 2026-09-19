/**
 * 功能概述：把 Runtime Manifest 与 Ledger 转换为版本化只读 Inspection API，复用 Gateway 认证。
 * 模块领域视图由 Manifest 指定 Kind/字段；仅查询持久化事实，语义摘要在统一脱敏后返回。
 * 主要职责：createInspectionService 提供模块、游标 Atom 页、详情和以 runtime context 为界的 Flow；
 * registerInspectionRoutes 仅注册 GET，先认证再校验查询，返回稳定错误及 no-store 缓存策略。
 * 代码库关系：由 app.ts 注册，server.ts 注入已启动 Runtime 的 inspectModules 和数据库只读端口；
 * schema 包约束 DTO，inspection-redaction.ts 统一清理所有响应，WebUI 不接触配置或原始数据库对象。
 * 输入输出与副作用：只执行有界读取；游标绑定过滤条件并校验时间/ID；Flow 不递归扩展其他 context，
 * registerInspectionRoutes 可接收动态 service getter，热切换期间返回 503，新实例生效后使用新的脱敏快照。
 * record-browser 的目录按根记录时间分页，引用分组由 inspection-records.ts 投影并在此统一脱敏。
 * 节点最多 500，边最多 2000，详情引用最多 100，明确报告截断和图外引用；无编辑、重放或订阅。
 */
import {
  recordItems,
  recordEntity,
  type RecordBrowser,
} from "./inspection-records.js";
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { InformationRepository, KaguyaDatabase } from "@kaguya/database";
import {
  z,
  inspectionModulesSchema,
  inspectionPageSchema,
  inspectionDetailSchema,
  inspectionFlowSchema,
  inspectionStorageSchema,
  inspectionSurfacePageSchema,
  inspectionRecordPageSchema,
  inspectionSurfaceEntitySchema,
  type InspectionModule,
  type JsonValue,
  type DeepReadonly,
  type InformationAtom,
  type ModuleInspectionSurfaceV1,
} from "@kaguya/schema";
import { createInspectionRedactor } from "./inspection-redaction.js";
import {
  readInspectionStorage,
  StorageCursorError,
} from "./inspection-storage.js";

const date = z.iso.datetime({ offset: true });
const id = z.string().min(1).max(512);
const pageQuery = z
  .object({
    kind: z.string().min(1).max(256).optional(),
    source: z.string().min(1).max(256).optional(),
    definitionId: z.string().min(1).max(256).optional(),
    view: z.string().min(1).max(256).optional(),
    after: date.optional(),
    before: date.optional(),
    cursor: z.string().min(1).max(4096).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict()
  .refine(
    (q) => !q.after || !q.before || Date.parse(q.after) < Date.parse(q.before),
  );
const cursorSchema = z
  .object({ occurredAt: date, informationId: id, filter: z.string() })
  .strict();
const surfaceCursorSchema = cursorSchema;
function parseRequest<T>(
  schema: { parse(value: unknown): T },
  value: unknown,
): T {
  try {
    return schema.parse(value);
  } catch {
    throw new InspectionError(400, "invalid_inspection_request");
  }
}
function readField(payload: unknown, path: string): JsonValue | undefined {
  let value = payload;
  for (const part of path.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part))
      return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value as JsonValue | undefined;
}
const summary = (
  a: DeepReadonly<InformationAtom>,
  modules: readonly InspectionModule[],
  redact: (value: unknown) => JsonValue,
) => {
  const safePayload = redact(a.payload);
  const kind = modules
    .flatMap((m) => [...m.produces, ...m.consumes])
    .find((k) => k.kind === a.kind);
  const view = modules
    .flatMap((m) => m.inspection?.views ?? [])
    .find((v) => v.kinds.includes(a.kind));
  const fields = (
    view?.fields ?? [
      { path: "text", label: "内容" },
      { path: "status", label: "结果" },
      { path: "reason", label: "原因" },
      { path: "task", label: "模型任务" },
      { path: "resolvedModel", label: "模型选择" },
      { path: "usage", label: "用量" },
      { path: "durationMs", label: "耗时（毫秒）" },
    ]
  ).flatMap((field) => {
    const value = readField(safePayload, field.path);
    return value === undefined
      ? []
      : [{ label: field.label, value: preview(value) }];
  });
  const status =
    readField(safePayload, "outcome") ??
    readField(safePayload, "status") ??
    readField(safePayload, "action.action");
  return {
    informationId: a.informationId,
    kind: a.kind,
    source: a.source,
    occurredAt: a.occurredAt,
    presentation: {
      title: kind?.displayName ?? a.kind,
      ...(typeof status === "string" ? { status } : {}),
      fields,
    },
  };
};
/** 摘要限制单个值的大小；完整脱敏原文仍由 detail 返回。 */
function preview(value: JsonValue, depth = 0): JsonValue {
  if (typeof value === "string")
    return value.length > 800
      ? value.slice(0, 800) + "…（摘要已截断，详情可查看完整内容）"
      : value;
  if (depth >= 4 && value !== null && typeof value === "object")
    return "（展开详情查看）";
  if (Array.isArray(value))
    return [
      ...value.slice(0, 24).map((v) => preview(v, depth + 1)),
      ...(value.length > 24 ? ["（更多内容见详情）"] : []),
    ];
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 32)
        .map(([k, v]) => [k, preview(v, depth + 1)]),
    );
  return value;
}
export interface InspectionSource {
  readonly ledger: Pick<InformationRepository, "get" | "inspectPage"> &
    Partial<
      Pick<
        InformationRepository,
        "getMany" | "inspectPayloadCounts" | "inspectEntityPage"
      >
    >;
  readonly modules: () => unknown;
  readonly secrets: unknown;
  readonly database?: KaguyaDatabase;
  readonly now?: () => Date;
}
type SurfaceBrowser = Extract<
  ModuleInspectionSurfaceV1["components"][number],
  { type: "entity-browser" }
>;
type SurfaceStatus = Extract<
  ModuleInspectionSurfaceV1["components"][number],
  { type: "status-summary" }
>;
type InspectionLedger = Pick<
  InformationRepository,
  | "get"
  | "getMany"
  | "inspectPage"
  | "inspectPayloadCounts"
  | "inspectEntityPage"
>;

function requireSurfaceLedger(
  ledger: InspectionSource["ledger"],
): InspectionLedger {
  if (
    !ledger.getMany ||
    !ledger.inspectPayloadCounts ||
    !ledger.inspectEntityPage
  )
    throw new InspectionError(503, "inspection_surface_unavailable");
  return ledger as InspectionLedger;
}

function findSurface(
  catalog: readonly InspectionModule[],
  definitionId: string,
  surfaceId: string,
) {
  const module = catalog.find((item) => item.definitionId === definitionId);
  const surface = module?.inspection?.surface;
  if (!module || !surface || surface.id !== surfaceId)
    throw new InspectionError(404, "module_surface_not_found");
  const browser = surface.components.find(
    (component): component is SurfaceBrowser | RecordBrowser =>
      component.type === "entity-browser" ||
      component.type === "record-browser",
  );
  const status = surface.components.find(
    (component): component is SurfaceStatus =>
      component.type === "status-summary",
  );
  if (!browser || (browser.type === "entity-browser" && !status))
    throw new InspectionError(500, "invalid_module_surface");
  return { module, surface, browser, status };
}

function readAtomField(
  atom: DeepReadonly<InformationAtom>,
  path: string,
): JsonValue | undefined {
  if (path === "informationId" || path === "occurredAt" || path === "source")
    return atom[path];
  return readField(atom.payload, path);
}

function uniqueStrings(values: readonly unknown[]): string[] {
  return [
    ...new Set(
      values.filter((value): value is string =>
        Boolean(typeof value === "string" && value.trim()),
      ),
    ),
  ].sort((a, b) => a.localeCompare(b));
}

function decodeSurfaceCursor(encoded: string | undefined, filter: string) {
  if (!encoded) return undefined;
  try {
    const cursor = surfaceCursorSchema.parse(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
    );
    if (cursor.filter !== filter) throw new Error("filter mismatch");
    return {
      occurredAt: cursor.occurredAt,
      informationId: cursor.informationId,
    };
  } catch {
    throw new InspectionError(400, "invalid_cursor");
  }
}

function encodeSurfaceCursor(
  item: { occurredAt: string; entityId: string },
  filter: string,
) {
  return Buffer.from(
    JSON.stringify({
      occurredAt: item.occurredAt,
      informationId: item.entityId,
      filter,
    }),
  ).toString("base64url");
}

async function eligibleSurfaceEntityIds(
  ledger: InspectionLedger,
  browser: SurfaceBrowser,
  query: {
    q?: string | undefined;
    platform?: string | undefined;
    status?: string | undefined;
  },
): Promise<Set<string> | undefined> {
  const restrictions: Set<string>[] = [];
  if (query.q) {
    const keys = new Set<string>();
    for (const field of browser.searchFields) {
      const rows = await ledger.inspectPage({
        kind: field.kind,
        payloadSearch: { paths: [field.path.split(".")], text: query.q },
        limit: 501,
      });
      for (const atom of rows) {
        const key = readAtomField(atom, browser.entityKeyField);
        if (typeof key === "string") keys.add(key);
      }
    }
    restrictions.push(
      new Set(
        (
          await ledger.inspectPage({
            kind: browser.entityKind,
            payloadIn: {
              path: browser.entityKeyField.split("."),
              values: [...keys],
            },
            limit: 501,
          })
        ).map(({ informationId }) => informationId),
      ),
    );
  }
  if (query.platform) {
    const accounts = await ledger.inspectPage({
      kind: browser.platform.kind,
      payloadIn: {
        path: browser.platform.field.split("."),
        values: [query.platform],
      },
      limit: 501,
    });
    const keys = uniqueStrings(
      accounts.map((atom) =>
        readAtomField(atom, browser.platform.entityKeyField),
      ),
    );
    restrictions.push(
      new Set(
        (
          await ledger.inspectPage({
            kind: browser.entityKind,
            payloadIn: {
              path: browser.entityKeyField.split("."),
              values: keys,
            },
            limit: 501,
          })
        ).map(({ informationId }) => informationId),
      ),
    );
  }
  if (query.status) {
    restrictions.push(
      new Set(
        (
          await ledger.inspectPage({
            kinds: browser.status.kinds,
            payloadIn: {
              path: browser.status.statusField.split("."),
              values: [query.status],
            },
            limit: 501,
          })
        ).flatMap((atom) => {
          const entityId = readAtomField(atom, browser.status.entityField);
          return typeof entityId === "string" ? [entityId] : [];
        }),
      ),
    );
  }
  if (!restrictions.length) return undefined;
  return restrictions
    .slice(1)
    .reduce(
      (result, set) => new Set([...result].filter((value) => set.has(value))),
      restrictions[0]!,
    );
}

async function buildSurfaceItems(
  ledger: InspectionLedger,
  browser: SurfaceBrowser,
  roots: readonly DeepReadonly<InformationAtom>[],
) {
  if (!roots.length) return [];
  const keys = uniqueStrings(
    roots.map((atom) => readAtomField(atom, browser.entityKeyField)),
  );
  const relatedKinds = uniqueStrings([
    browser.platform.kind,
    ...browser.searchFields.map(({ kind }) => kind),
  ]);
  const related = await ledger.inspectPage({
    kinds: relatedKinds,
    payloadIn: { path: browser.entityKeyField.split("."), values: keys },
    limit: 501,
  });
  const statuses = await ledger.inspectPage({
    kinds: browser.status.kinds,
    payloadIn: {
      path: browser.status.entityField.split("."),
      values: roots.map(({ informationId }) => informationId),
    },
    limit: 501,
  });
  return roots.map((root) => {
    const entityKey = String(
      readAtomField(root, browser.entityKeyField) ?? root.informationId,
    );
    const rows = related.filter(
      (atom) => readAtomField(atom, browser.entityKeyField) === entityKey,
    );
    const platformRow = rows.find(
      (atom) => atom.kind === browser.platform.kind,
    );
    const statusRow = statuses.find(
      (atom) =>
        readAtomField(atom, browser.status.entityField) === root.informationId,
    );
    const title =
      browser.titleFields
        .map(({ path }) =>
          [root, ...rows]
            .map((atom) => readAtomField(atom, path))
            .find((value) => typeof value === "string" && value.trim()),
        )
        .find((value) => typeof value === "string") ?? entityKey;
    const platform = platformRow
      ? readAtomField(platformRow, browser.platform.field)
      : undefined;
    const status = statusRow
      ? readAtomField(statusRow, browser.status.statusField)
      : undefined;
    const latest = rows[0]?.occurredAt ?? root.occurredAt;
    return {
      entityId: root.informationId,
      entityKey,
      title,
      subtitle: `${typeof platform === "string" ? platform : "未知平台"} · ${entityKey}`,
      ...(typeof platform === "string" ? { platform } : {}),
      ...(typeof status === "string" ? { status } : {}),
      occurredAt: latest,
      fields: [
        { label: "账号", value: entityKey },
        ...(typeof platform === "string"
          ? [{ label: "平台", value: platform }]
          : []),
        { label: "最近观察", value: latest },
      ],
    };
  });
}
export function createInspectionService(source: InspectionSource) {
  const redact = createInspectionRedactor(source.secrets);
  const modules = () =>
    inspectionModulesSchema.parse({ version: 1, modules: source.modules() })
      .modules;
  return {
    modules() {
      return inspectionModulesSchema.parse(
        redact({ version: 1, modules: source.modules() }),
      );
    },
    async atoms(input: unknown, contextsOnly = false) {
      const {
        cursor: encoded,
        limit,
        ...filters
      } = parseRequest(pageQuery, input);
      const catalog = modules();
      let kinds: readonly string[] | undefined;
      if (filters.definitionId || filters.view) {
        if (contextsOnly || !filters.definitionId || !filters.view)
          throw new InspectionError(400, "invalid_module_view");
        const module = catalog.find(
          (m) => m.definitionId === filters.definitionId,
        );
        const view = module?.inspection?.views.find(
          (v) => v.id === filters.view,
        );
        if (!module || !view)
          throw new InspectionError(404, "module_view_not_found");
        if (filters.kind && !view.kinds.includes(filters.kind))
          throw new InspectionError(400, "invalid_module_kind");
        if (
          filters.source &&
          !module.bindings.some(
            (b) => filters.source === `module:${b.instanceId}`,
          )
        )
          throw new InspectionError(400, "invalid_module_source");
        kinds = view.kinds;
      }
      if (contextsOnly) filters.kind = "core.runtime.context";
      const filter = createHash("sha256")
        .update(JSON.stringify(filters))
        .digest("hex");
      let cursor: z.infer<typeof cursorSchema> | undefined;
      if (encoded !== undefined) {
        try {
          cursor = cursorSchema.parse(
            JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
          );
        } catch {
          throw new InspectionError(400, "invalid_cursor");
        }
        if (cursor.filter !== filter)
          throw new InspectionError(400, "invalid_cursor");
      }
      const rows = await source.ledger.inspectPage({
        ...(kinds ? { kinds } : {}),
        ...(filters.kind ? { kind: filters.kind } : {}),
        ...(filters.source ? { source: filters.source } : {}),
        ...(filters.after ? { after: filters.after } : {}),
        ...(filters.before ? { before: filters.before } : {}),
        limit: limit + 1,
        ...(cursor ? { cursor } : {}),
      });
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      const nextCursor =
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({
                occurredAt: last.occurredAt,
                informationId: last.informationId,
                filter,
              }),
            ).toString("base64url")
          : null;
      // 游标只携带分页定位字段；内容与元数据均经相同脱敏器。
      return inspectionPageSchema.parse({
        version: 1,
        items: redact(items.map((a) => summary(a, catalog, redact))),
        nextCursor,
        truncated: rows.length > limit,
      });
    },
    async detail(informationId: string) {
      const catalog = modules();
      const atom = await source.ledger.get(parseRequest(id, informationId));
      if (!atom) throw new InspectionError(404, "atom_not_found");
      const reverse = await source.ledger.inspectPage({
        referencedId: informationId,
        limit: 101,
      });
      return inspectionDetailSchema.parse(
        redact({
          version: 1,
          atom: {
            ...summary(atom, catalog, redact),
            payload: atom.payload,
            references: atom.references.slice(0, 100).map((r) => ({
              relation: r.relation,
              informationId: r.informationId,
            })),
          },
          referencedBy: reverse
            .slice(0, 100)
            .map((a) => summary(a, catalog, redact)),
          referencesTruncated: atom.references.length > 100,
          reverseReferencesTruncated: reverse.length > 100,
        }),
      );
    },
    async flow(contextInformationId: string, input: unknown) {
      const catalog = modules();
      const flowQuery = z
        .object({ limit: z.coerce.number().int().min(2).max(500).default(200) })
        .strict();
      const { limit } = parseRequest(flowQuery, input);
      const context = await source.ledger.get(
        parseRequest(id, contextInformationId),
      );
      if (!context || context.kind !== "core.runtime.context")
        throw new InspectionError(404, "context_not_found");
      const rows = await source.ledger.inspectPage({
        referencedId: contextInformationId,
        relation: "core:context",
        limit,
      });
      const atoms = [context, ...rows.slice(0, limit - 1)].sort(
        (a, b) =>
          Date.parse(a.occurredAt) - Date.parse(b.occurredAt) ||
          a.informationId.localeCompare(b.informationId),
      );
      const ids = new Set(atoms.map((a) => a.informationId));
      const edges: { from: string; to: string; relation: string }[] = [];
      let externalReferences = 0;
      let truncated = rows.length >= limit;
      for (const atom of atoms)
        for (const reference of atom.references) {
          if (!ids.has(reference.informationId)) {
            externalReferences++;
            continue;
          }
          if (edges.length >= 2000) {
            truncated = true;
            continue;
          }
          edges.push({
            from: atom.informationId,
            to: reference.informationId,
            relation: reference.relation,
          });
        }
      return inspectionFlowSchema.parse(
        redact({
          version: 1,
          contextInformationId,
          nodes: atoms.map((a) => summary(a, catalog, redact)),
          edges,
          truncated,
          externalReferences,
        }),
      );
    },
    async storage(definitionId: string, input: unknown) {
      const module = modules().find((m) => m.definitionId === definitionId);
      if (!module?.inspection?.storage)
        throw new InspectionError(404, "module_storage_not_found");
      const query = parseRequest(
        z
          .object({
            cursor: z.string().min(1).max(512).optional(),
            limit: z.coerce.number().int().min(1).max(50).default(20),
          })
          .strict(),
        input,
      );
      if (!source.database)
        throw new InspectionError(503, "inspection_unavailable");
      return inspectionStorageSchema.parse(
        redact(
          await readInspectionStorage(
            source.database,
            module.inspection.storage,
            query,
          ),
        ),
      );
    },
    async surface(definitionId: string, surfaceId: string, input: unknown) {
      const ledger = requireSurfaceLedger(source.ledger);
      const { module, surface, browser, status } = findSurface(
        modules(),
        definitionId,
        surfaceId,
      );
      const query = parseRequest(
        z
          .object({
            cursor: z.string().min(1).max(4096).optional(),
            limit: z.coerce.number().int().min(1).max(50).default(20),
            q: z.string().trim().max(100).optional(),
            platform: z.string().trim().min(1).max(100).optional(),
            status: z.string().trim().min(1).max(100).optional(),
          })
          .strict(),
        input,
      );
      const filter = createHash("sha256")
        .update(
          JSON.stringify({
            definitionId,
            surfaceId,
            q: query.q ?? "",
            platform: query.platform ?? "",
            status: query.status ?? "",
          }),
        )
        .digest("hex");
      const cursor = decodeSurfaceCursor(query.cursor, filter);
      if (browser.type === "record-browser") {
        if (query.platform || query.status)
          throw new InspectionError(400, "invalid_inspection_request");
        const rows = await ledger.inspectPage({
          kind: browser.recordKind,
          limit: query.limit + 1,
          ...(cursor ? { cursor } : {}),
          ...(query.q
            ? {
                payloadSearch: {
                  paths: browser.searchFields.map((path) => path.split(".")),
                  text: query.q,
                },
              }
            : {}),
        });
        const items = await recordItems(
          ledger,
          browser,
          rows.slice(0, query.limit),
        );
        const last = items.at(-1);
        return inspectionRecordPageSchema.parse(
          redact({
            version: 1,
            surfaceId: surface.id,
            items,
            nextCursor:
              rows.length > query.limit && last
                ? encodeSurfaceCursor(last, filter)
                : null,
          }),
        );
      }
      if (!status) throw new InspectionError(500, "invalid_module_surface");
      const entityIds = await eligibleSurfaceEntityIds(ledger, browser, query);
      const roots = await ledger.inspectEntityPage({
        rootKind: browser.entityKind,
        rootKeyPath: browser.entityKeyField.split("."),
        activityKinds: browser.activity.kinds,
        activityKeyPath: browser.activity.entityKeyField.split("."),
        limit: query.limit + 1,
        ...(cursor ? { cursor } : {}),
        ...(entityIds ? { informationIds: [...entityIds] } : {}),
      });
      const page = roots.slice(0, query.limit);
      const items = await buildSurfaceItems(ledger, browser, page);
      const summaryAfter = new Date(
        (source.now?.() ?? new Date()).getTime() -
          status.windowHours * 60 * 60 * 1000,
      ).toISOString();
      const counts = await ledger.inspectPayloadCounts({
        kinds: status.kinds,
        path: status.statusField.split("."),
        after: summaryAfter,
      });
      const platformRows = await ledger.inspectPage({
        kind: browser.platform.kind,
        limit: 501,
      });
      const platforms = uniqueStrings(
        platformRows.map((atom) => readAtomField(atom, browser.platform.field)),
      );
      const statuses = [
        "complete",
        "unresolved",
        "ambiguous",
        "degraded",
        "failed",
        ...uniqueStrings(counts.map(({ value }) => value)).filter(
          (value) =>
            ![
              "complete",
              "unresolved",
              "ambiguous",
              "degraded",
              "failed",
            ].includes(value),
        ),
      ];
      const last = items.at(-1);
      return inspectionSurfacePageSchema.parse(
        redact({
          version: 1,
          surfaceId: surface.id,
          summary: {
            windowStartedAt: summaryAfter,
            windowHours: status.windowHours,
            counts: statuses.map((value) => ({
              status: value,
              count: counts.find((item) => item.value === value)?.count ?? 0,
            })),
          },
          items,
          platforms,
          statuses,
          nextCursor:
            roots.length > query.limit && last
              ? encodeSurfaceCursor(last, filter)
              : null,
        }),
      );
    },
    async surfaceEntity(
      definitionId: string,
      surfaceId: string,
      entityId: string,
    ) {
      const ledger = requireSurfaceLedger(source.ledger);
      const { surface, browser } = findSurface(
        modules(),
        definitionId,
        surfaceId,
      );
      const root = await ledger.get(parseRequest(id, entityId));
      if (browser.type === "record-browser") {
        if (!root || root.kind !== browser.recordKind)
          throw new InspectionError(404, "surface_entity_not_found");
        return inspectionSurfaceEntitySchema.parse(
          redact({
            version: 1,
            surfaceId: surface.id,
            ...(await recordEntity(ledger, browser, root)),
          }),
        );
      }
      if (!root || root.kind !== browser.entityKind)
        throw new InspectionError(404, "surface_entity_not_found");
      const [entity] = await buildSurfaceItems(ledger, browser, [root]);
      if (!entity) throw new InspectionError(404, "surface_entity_not_found");
      const entityKey = String(
        readAtomField(root, browser.entityKeyField) ?? "",
      );
      const sections = [];
      for (const relation of browser.relations) {
        const matchValue =
          relation.match.source === "entity-id" ? entityId : entityKey;
        let matchValues = [matchValue];
        if (relation.via) {
          const viaRows = await ledger.inspectPage({
            kinds: relation.via.kinds,
            payloadIn: {
              path: relation.via.matchField.split("."),
              values: [matchValue],
            },
            limit: 501,
          });
          matchValues = uniqueStrings(
            viaRows.map((atom) =>
              readAtomField(atom, relation.via!.selectField),
            ),
          );
        }
        const rows = matchValues.length
          ? await ledger.inspectPage({
              kinds: relation.kinds,
              ...(relation.match.field === "informationId"
                ? { informationIds: matchValues }
                : {
                    payloadIn: {
                      path: relation.match.field.split("."),
                      values: matchValues,
                    },
                  }),
              limit: Math.min(501, relation.limit + 1),
            })
          : [];
        sections.push({
          id: relation.id,
          title: relation.title,
          presentation: relation.presentation,
          items: rows.slice(0, relation.limit).map((atom) => ({
            id: atom.informationId,
            occurredAt: atom.occurredAt,
            ...(typeof readAtomField(atom, "status") === "string"
              ? { status: readAtomField(atom, "status") }
              : {}),
            fields: relation.fields.flatMap(({ path, label }) => {
              const value = readAtomField(atom, path);
              return value === undefined ? [] : [{ label, value }];
            }),
            sourceInformationId: atom.informationId,
          })),
        });
      }
      return inspectionSurfaceEntitySchema.parse(
        redact({ version: 1, surfaceId: surface.id, entity, sections }),
      );
    },
  };
}
export type InspectionService = ReturnType<typeof createInspectionService>;
class InspectionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export function registerInspectionRoutes(
  app: FastifyInstance,
  service:
    InspectionService | (() => InspectionService | undefined) | undefined,
  authenticate: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<unknown>,
) {
  const routes: [
    string,
    (request: FastifyRequest, service: InspectionService) => unknown,
  ][] = [
    ["modules", (_, s) => s.modules()],
    [
      "modules/:definitionId/surfaces/:surfaceId",
      (r, s) => {
        const params = parseRequest(
          z.object({ definitionId: id, surfaceId: id }),
          r.params,
        );
        return s.surface(params.definitionId, params.surfaceId, r.query);
      },
    ],
    [
      "modules/:definitionId/surfaces/:surfaceId/entities/:entityId",
      (r, s) => {
        const params = parseRequest(
          z.object({ definitionId: id, surfaceId: id, entityId: id }),
          r.params,
        );
        return s.surfaceEntity(
          params.definitionId,
          params.surfaceId,
          params.entityId,
        );
      },
    ],
    [
      "modules/:definitionId/storage",
      (r, s) =>
        s.storage(
          parseRequest(z.object({ definitionId: id }), r.params).definitionId,
          r.query,
        ),
    ],
    ["atoms", (r, s) => s.atoms(r.query)],
    [
      "atoms/:informationId",
      (r, s) =>
        s.detail(
          parseRequest(z.object({ informationId: id }), r.params).informationId,
        ),
    ],
    ["flows", (r, s) => s.atoms(r.query, true)],
    [
      "flows/:informationId",
      (r, s) =>
        s.flow(
          parseRequest(z.object({ informationId: id }), r.params).informationId,
          r.query,
        ),
    ],
  ];
  for (const [path, handler] of routes)
    app.get(
      `/api/v1/inspection/${path}`,
      {
        onRequest: async (r, reply) => {
          reply.header("Cache-Control", "no-store");
          return authenticate(r, reply);
        },
        schema: {
          tags: ["Inspection"],
          security: [{ bearerAuth: [] }],
          summary: `Read ${path}`,
        },
      },
      async (request, reply) => {
        try {
          const active = typeof service === "function" ? service() : service;
          if (!active) throw new InspectionError(503, "inspection_unavailable");
          return { data: await handler(request, active) };
        } catch (error) {
          const status =
            error instanceof InspectionError
              ? error.status
              : error instanceof StorageCursorError
                ? 400
                : 500;
          const code =
            error instanceof InspectionError
              ? error.code
              : status === 400
                ? "invalid_inspection_request"
                : "inspection_failed";
          // 驱动异常和未脱敏原子不得进入 HTTP 错误或日志。
          return reply
            .code(status)
            .send({ error: { code, message: code, requestId: request.id } });
        }
      },
    );
}
