/**
 * 功能概述：把 Manifest 的 record-browser 投影为通用 Surface DTO，按记录时间浏览查询及其因果结果。
 * 主要职责：recordItems 生成目录与根字段；recordEntity 沿声明的反向引用读取分组，按 rank 排序并投影 canonical source。
 * 代码库关系：inspection.ts 负责认证、参数/游标校验及最终脱敏；本文件只使用数据库有界只读端口和 Schema 声明。
 * 输入输出与副作用：不启动模块、不执行检索、不写账本；每组明确截断，缺失或 Kind 不匹配的来源不输出正文。
 */
import type { InformationRepository } from "@kaguya/database";
import type {
  DeepReadonly,
  InformationAtom,
  JsonValue,
  ModuleInspectionSurfaceV1,
} from "@kaguya/schema";
export type RecordBrowser = Extract<
  ModuleInspectionSurfaceV1["components"][number],
  { type: "record-browser" }
>;
type Ledger = Pick<InformationRepository, "get" | "getMany" | "inspectPage">;
type Atom = DeepReadonly<InformationAtom>;
function field(atom: Atom, path: string): JsonValue | undefined {
  if (path === "occurredAt" || path === "informationId" || path === "source")
    return atom[path];
  let value: unknown = atom.payload;
  for (const key of path.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
      return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value as JsonValue | undefined;
}
function fields(atom: Atom, declaration: { path: string; label: string }[]) {
  return declaration.flatMap(({ path, label }) => {
    const value = field(atom, path);
    return value === undefined ? [] : [{ label, value }];
  });
}
async function related(
  ledger: Ledger,
  root: Atom,
  relation: RecordBrowser["relations"][number],
) {
  return ledger.inspectPage({
    kinds: relation.kinds,
    referencedId: root.informationId,
    relation: relation.reference,
    limit: relation.limit + 1,
  });
}
export async function recordItems(
  ledger: Ledger,
  browser: RecordBrowser,
  roots: readonly Atom[],
) {
  const result = browser.relations.find(
    (item) => item.presentation === "field-grid",
  );
  return Promise.all(
    roots.map(async (root) => {
      const terminal = result
        ? (await related(ledger, root, result))[0]
        : undefined;
      const status = terminal ? field(terminal, "status") : undefined;
      return {
        entityId: root.informationId,
        entityKey: root.informationId,
        title: String(field(root, browser.titleField) ?? "未记录查询内容"),
        subtitle: "",
        occurredAt: root.occurredAt,
        ...(typeof status === "string" ? { status } : {}),
        fields: fields(root, browser.fields),
      };
    }),
  );
}
export async function recordEntity(
  ledger: Ledger,
  browser: RecordBrowser,
  root: Atom,
) {
  const [entity] = await recordItems(ledger, browser, [root]);
  const sections = await Promise.all(
    browser.relations.map(async (relation) => {
      const rows = await related(ledger, root, relation);
      const ordered = rows.slice(0, relation.limit);
      if (relation.rankField)
        ordered.sort(
          (a, b) =>
            Number(field(a, relation.rankField!)) -
            Number(field(b, relation.rankField!)),
        );
      const sourceIds = relation.source
        ? ordered.flatMap((atom) =>
            atom.references
              .filter((ref) => ref.relation === relation.source!.reference)
              .map((ref) => ref.informationId),
          )
        : [];
      const sources = sourceIds.length
        ? await ledger.getMany([...new Set(sourceIds)])
        : [];
      return {
        id: relation.id,
        title: relation.title,
        presentation: relation.presentation,
        truncated: rows.length > relation.limit,
        items: ordered.map((atom) => {
          const status = field(atom, "status");
          const rank = relation.rankField
            ? field(atom, relation.rankField)
            : undefined;
          const sourceId = atom.references.find(
            (ref) => ref.relation === relation.source?.reference,
          )?.informationId;
          const source = sources.find(
            (item) =>
              item.informationId === sourceId &&
              relation.source!.kinds.includes(item.kind),
          );
          return {
            id: atom.informationId,
            occurredAt: atom.occurredAt,
            ...(typeof status === "string" ? { status } : {}),
            ...(typeof rank === "number" ? { rank } : {}),
            fields: fields(atom, relation.fields),
            sourceInformationId: atom.informationId,
            ...(relation.source
              ? {
                  relatedSource: {
                    ...(source ? { informationId: source.informationId } : {}),
                    available: Boolean(source),
                    fields: source
                      ? fields(source, relation.source.fields)
                      : [],
                  },
                }
              : {}),
          };
        }),
      };
    }),
  );
  return { entity, sections };
}
