/**
 * 功能概述：Router 在旧 scope 索引内按完整 scene 读取 claim 与 Focus，避免分隔符碰撞跨会话接续。
 * findSceneFacts 分页扫描并沿显式来源恢复归属，再返回指定数量的同场景事实；遗漏来源的旧事实不被推定归属。
 * 代码库关系：state-query 与 focus 的只读选择器共用 Lifecycle 地址解析；不改变事实格式或迁移旧账本。
 * 输入输出与副作用：输入账本、完整地址和有界查询，返回已核验事实；每页至多 1000 条，读取缓存仅限本次调用。
 */
import {
  sceneIdentity,
  type SceneAddress,
  type DeepReadonly,
  type InformationAtom,
} from "@kaguya/schema";
import type { InformationSelectorLedger } from "@kaguya/sdk";
import { resolveObservationAddress } from "../lifecycle/observation-scene.js";
export async function findSceneFacts(
  ledger: InformationSelectorLedger,
  address: SceneAddress,
  query: Parameters<InformationSelectorLedger["find"]>[0],
) {
  const selected: DeepReadonly<InformationAtom>[] = [];
  const cache = new Map<string, DeepReadonly<InformationAtom> | undefined>();
  let cursor: string | undefined;
  const order = query.order ?? "desc";
  for (;;) {
    const page = await ledger.find({
      ...query,
      registrationOrder: true,
      order,
      limit: 1000,
      ...(cursor
        ? order === "desc"
          ? { throughInformationId: cursor }
          : { afterInformationId: cursor }
        : {}),
    });
    for (const atom of page) cache.set(atom.informationId, atom);
    for (const atom of page) {
      if (atom.informationId === cursor) continue;
      const found = await resolveObservationAddress(atom, async (id) => {
        if (!cache.has(id))
          cache.set(
            id,
            (await ledger.find({ informationIds: [id], limit: 1 }))[0],
          );
        return cache.get(id);
      });
      if (found && sceneIdentity(found) === sceneIdentity(address))
        selected.push(atom);
      if (selected.length >= (query.limit ?? 1000)) return selected;
    }
    if (page.length < 1000) return selected;
    cursor = page.at(-1)!.informationId;
  }
}
