/**
 * 功能概述：在清理媒体字节前读取来源、可靠订阅与平台投递状态，保护重放和未知结果核对。
 * 主要职责：mediaResourceRetentionGuard 返回异步只读谓词；持久来源没有 TTL，待处理/已领取
 * 的资源或其生成工作保留，直接字节引用与 core:result 引用的投递都等待明确终态。
 * 代码库关系：Runtime 将本谓词传给文件/PostgreSQL MediaResourceStore.cleanupExpired。
 * 输入输出与副作用：输入摘要资源 ID，返回是否仍须保留；不修改事实、授权或投递状态。
 * unknown 不能释放资源；一个投递的终态不能覆盖同资源仍在进行的另一项可靠工作。
 */
import type { SqlDatabase } from "@kaguya/database";

export function mediaResourceRetentionGuard(
  database: Pick<SqlDatabase, "query">,
) {
  return async (resourceId: string): Promise<boolean> => {
    const result = await database.query(
      `SELECT 1 FROM media_sources WHERE metadata->>'resourceId' = $1
       UNION ALL
       SELECT 1 FROM information_atoms resource
       WHERE resource.payload->>'resourceId' = $1
         AND (
           EXISTS (SELECT 1 FROM information_deliveries pending
             WHERE pending.information_id = resource.information_id
               AND pending.state IN ('pending', 'claimed'))
           OR EXISTS (
             SELECT 1 FROM information_references cause
             JOIN information_deliveries pending ON pending.information_id = cause.target_information_id
             WHERE cause.information_id = resource.information_id AND cause.relation = 'core:caused-by'
               AND pending.state IN ('pending', 'claimed')
           )
         )
       UNION ALL
       SELECT 1 FROM information_atoms d
       WHERE d.kind = 'core.delivery.requested'
         AND (
           d.payload->'message'->>'resourceId' = $1
           OR EXISTS (
             SELECT 1 FROM information_references resource_ref
             JOIN information_atoms resource ON resource.information_id = resource_ref.target_information_id
             WHERE resource_ref.information_id = d.information_id
               AND resource_ref.relation = 'core:result'
               AND resource.payload->>'resourceId' = $1
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM information_references status
           JOIN information_atoms terminal ON terminal.information_id = status.information_id
           WHERE status.target_information_id = d.information_id
             AND status.relation = 'core:status-of'
             AND (terminal.kind = 'core.delivery.delivered' OR
                   (terminal.kind = 'core.delivery.failed' AND terminal.payload->>'outcome' IS DISTINCT FROM 'unknown'))
         ) LIMIT 1`,
      [resourceId],
    );
    return result.rows.length > 0;
  };
}
