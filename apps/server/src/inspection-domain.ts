/**
 * 功能概述：组合跨领域只读 Inspection 服务，供现有认证路由调用，不向客户端开放 SQL 或领域 mutation。
 * createDomainInspection 共享签名游标/脱敏闭包，按观察、原生循环、行动、Memory 和环境分别产出版本化 DTO。
 * 正规 Memory 来源必须匹配 Atom 身份、originalInformationId 与原来源引用，不能借用其他来源证明。
 * 代码库关系：inspection.ts 持有此服务，server.ts 动态提供数据库与环境只读门面；UI 留在现有工作台。
 */
import {
  persistedSourceProofOwners,
  readMemoryInvalidations,
  type KaguyaDatabase,
} from "@kaguya/database";
import { inspectionSourceSchema } from "@kaguya/schema";
import {
  DomainReader,
  denied,
  permittedFact,
  hasReference,
  reference,
  serialMap,
} from "./inspection-domain-common.js";
import { observationInspection } from "./inspection-observations.js";
import { runInspection } from "./inspection-runs.js";
import { actionInspection } from "./inspection-actions.js";
import { memoryInspection } from "./inspection-memory.js";
import {
  environmentInspection,
  type InspectionEnvironmentSource,
} from "./inspection-environments.js";

export function createDomainInspection(source: {
  database?: KaguyaDatabase;
  secrets: unknown;
  environments?: () => InspectionEnvironmentSource | undefined;
}) {
  const reader = new DomainReader(source.database, source.secrets);
  return {
    source: (id: string, input: unknown) =>
      reader.read(input, `source:${id}`, async (r, q, meta) => {
        const f = await r.fact(id);
        if (!f || !(await permittedFact(r, f, q.scope))) throw denied();
        let reason:
          | "source-proof-missing"
          | "source-withdrawal"
          | "identity-split"
          | "domain-detail-required"
          | null = null;
        // Operational contents are interpreted by their typed domain projection, including receipt/call pairing.
        if (
          /^(core\.(action|model)\.|agent\.heavy\.tool\.|mcp\.client\.late-result\.)/.test(
            f.kind,
          )
        )
          reason = "domain-detail-required";
        if (f.kind === "memory.native.source.v1") {
          const original = f.payload.memorySource?.id;
          if (
            typeof original !== "string" ||
            f.id !== `memory-native-source:${original}` ||
            f.payload.originalInformationId !== original ||
            !hasReference(f, original, "core:uses-context")
          )
            reason = "source-proof-missing";
          else {
            const proof = await persistedSourceProofOwners(
              r.tx,
              [original],
              r.boundary.position,
            );
            const owners = [...proof]
              .filter(([, ids]) => ids.has(original))
              .map(([owner]) => owner);
            if (!owners.length) reason = "source-proof-missing";
            else {
              const effects = await readMemoryInvalidations(
                r.tx,
                undefined,
                owners,
                [original],
              );
              if (effects.withdrawn.size) reason = "source-withdrawal";
              else if (effects.identities.size) reason = "identity-split";
            }
          }
        }
        return inspectionSourceSchema.parse({
          ...meta,
          informationId: id,
          kind: f.kind,
          occurredAt: f.at,
          availability: reason ? "unavailable" : "available",
          reason,
          content: reason ? null : reader.safe(f.payload),
          references: !reason
            ? await serialMap(f.references.slice(0, 100), (ref) =>
                reference(r, q.scope, ref.informationId, ref.relation),
              )
            : [],
          referencesTruncated: f.references.length > 100,
        });
      }),
    ...observationInspection(reader),
    ...runInspection(reader),
    ...actionInspection(reader),
    ...memoryInspection(reader),
    ...environmentInspection(reader, source.environments ?? (() => undefined)),
  };
}
