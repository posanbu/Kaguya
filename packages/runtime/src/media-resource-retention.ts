/** 只读账本状态决定媒体是否仍处于投递或恢复窗口，不修改业务事实。 */
import type { SqlDatabase } from "@kaguya/database";

export function mediaResourceRetentionGuard(
  database: Pick<SqlDatabase, "query">,
) {
  return async (resourceId: string): Promise<boolean> => {
    const result = await database.query(
      `SELECT 1 FROM information_atoms resource
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
         AND NOT EXISTS (
           SELECT 1 FROM information_references r
           JOIN information_atoms d ON d.information_id = r.information_id
           WHERE r.target_information_id = resource.information_id
             AND r.relation = 'core:result' AND d.kind = 'core.delivery.requested'
             AND EXISTS (
               SELECT 1 FROM information_references status
               JOIN information_atoms terminal ON terminal.information_id = status.information_id
               WHERE status.target_information_id = d.information_id
                 AND status.relation = 'core:status-of'
                 AND terminal.kind IN ('core.delivery.delivered', 'core.delivery.failed')
             )
         )
       UNION ALL
       SELECT 1 FROM information_atoms d
       WHERE d.kind = 'core.delivery.requested'
         AND d.payload->'message'->>'resourceId' = $1
         AND NOT EXISTS (
           SELECT 1 FROM information_references status
           JOIN information_atoms terminal ON terminal.information_id = status.information_id
           WHERE status.target_information_id = d.information_id
             AND status.relation = 'core:status-of'
             AND terminal.kind IN ('core.delivery.delivered', 'core.delivery.failed')
         ) LIMIT 1`,
      [resourceId],
    );
    return result.rows.length > 0;
  };
}
