/** 从人物绑定和身份事件投影只读基础资料，不按裸账号 ID 推断人物归属。 */
import type { KaguyaDatabase } from "@kaguya/database";

export interface PersonAccountRow {
  platform: string;
  adapterId: string;
  accountId: string;
  nickname: string | null;
  accountInformationId: string;
  bindingInformationId: string;
}

export interface PersonGroupCardRow {
  platform: string;
  groupId: string;
  card: string;
  observedAt: string;
  sourceInformationId: string;
}

export async function readPersonBasics(
  database: KaguyaDatabase,
  personInformationId: string,
) {
  const accountsResult = await database.sql.query<{
    platform: string;
    adapter_id: string;
    account_id: string;
    nickname: string | null;
    account_information_id: string;
    binding_information_id: string;
  }>(
    `SELECT account.payload->>'platform' AS platform,
       account.payload->>'adapterId' AS adapter_id,
       account.payload->>'accountId' AS account_id,
       account.information_id AS account_information_id,
       binding.information_id AS binding_information_id,
       (SELECT observed.payload->>'nickname'
        FROM information_atoms observed
        JOIN information_references observed_ref
          ON observed_ref.information_id=observed.information_id
          AND observed_ref.relation='core:observes'
        JOIN information_lifecycle observed_lifecycle
          ON observed_lifecycle.information_id=observed.information_id
        WHERE observed.kind='memory.identity.person.observed'
          AND observed_ref.target_information_id=account.information_id
          AND observed.payload->>'nickname' IS NOT NULL
        ORDER BY observed_lifecycle.position DESC LIMIT 1) AS nickname
     FROM information_atoms binding
     JOIN information_references account_ref
       ON account_ref.information_id=binding.information_id
       AND account_ref.relation='core:binds'
     JOIN information_atoms account
       ON account.information_id=account_ref.target_information_id
       AND account.kind='memory.identity.platform.account.entity'
     WHERE binding.kind='memory.identity.platform.account.binding'
       AND binding.payload->>'personInformationId'=$1
     ORDER BY platform, adapter_id, account_id, binding.information_id
     LIMIT 501`,
    [personInformationId],
  );
  const accountMap = new Map<string, PersonAccountRow>();
  for (const row of accountsResult.rows) {
    if (!row.platform || !row.adapter_id || !row.account_id) continue;
    accountMap.set(row.account_information_id, {
      platform: row.platform,
      adapterId: row.adapter_id,
      accountId: row.account_id,
      nickname: row.nickname,
      accountInformationId: row.account_information_id,
      bindingInformationId: row.binding_information_id,
    });
  }
  const accounts = [...accountMap.values()].slice(0, 500);
  const cards: PersonGroupCardRow[] = [];
  let groupCardsTruncated = false;
  if (accounts.length) {
    const observations = await database.sql.query<{
      account_information_id: string;
      source_information_id: string;
      card: string;
      observed_at: string;
      group_id: string | null;
    }>(
      `SELECT observed_ref.target_information_id AS account_information_id,
         observed.information_id AS source_information_id,
         observed.payload->>'card' AS card,
         observed.occurred_at AS observed_at,
         COALESCE(inbound.payload#>>'{source,destination,groupId}',
                  inbound.payload#>>'{source,destination,id}') AS group_id
       FROM information_atoms observed
       JOIN information_references observed_ref
         ON observed_ref.information_id=observed.information_id
         AND observed_ref.relation='core:observes'
       JOIN information_references caused_by
         ON caused_by.information_id=observed.information_id
         AND caused_by.relation='core:caused-by'
       JOIN information_atoms inbound
         ON inbound.information_id=caused_by.target_information_id
       JOIN information_lifecycle observed_lifecycle
         ON observed_lifecycle.information_id=observed.information_id
       WHERE observed.kind='memory.identity.person.observed'
         AND observed_ref.target_information_id=ANY($1::text[])
         AND observed.payload->>'card' IS NOT NULL
       ORDER BY observed_lifecycle.position DESC
       LIMIT 1001`,
      [accounts.map((account) => account.accountInformationId)],
    );
    groupCardsTruncated = observations.rows.length > 1000;
    const seen = new Set<string>();
    for (const row of observations.rows) {
      const account = accountMap.get(row.account_information_id);
      if (!account || !row.group_id || !row.card) continue;
      const key = JSON.stringify([account.platform, row.group_id]);
      if (seen.has(key)) continue;
      seen.add(key);
      cards.push({
        platform: account.platform,
        groupId: row.group_id,
        card: row.card,
        observedAt: row.observed_at,
        sourceInformationId: row.source_information_id,
      });
    }
  }
  const statistics = await database.sql.query<{
    count: string;
    first_at: string | null;
    last_at: string | null;
  }>(
    `SELECT COUNT(*)::text AS count, MIN(occurred_at) AS first_at,
       MAX(occurred_at) AS last_at
     FROM information_atoms
     WHERE kind='memory.identity.person.context.completed'
       AND payload->>'personInformationId'=$1
       AND payload->>'status'='complete'`,
    [personInformationId],
  );
  const stats = statistics.rows[0];
  return {
    accounts,
    accountsTruncated:
      accountMap.size > 500 || accountsResult.rows.length > 500,
    groupCards: cards,
    groupCardsTruncated,
    recognitionStats: {
      count: Number(stats?.count ?? 0),
      firstAt: stats?.first_at ?? null,
      lastAt: stats?.last_at ?? null,
    },
  };
}

export async function findPeopleByAccount(
  database: KaguyaDatabase,
  options: { q?: string; platform?: string },
): Promise<Set<string>> {
  const rows = await database.sql.query<{ person_information_id: string }>(
    `SELECT DISTINCT binding.payload->>'personInformationId' AS person_information_id
     FROM information_atoms binding
     JOIN information_references account_ref
       ON account_ref.information_id=binding.information_id
       AND account_ref.relation='core:binds'
     JOIN information_atoms account
       ON account.information_id=account_ref.target_information_id
       AND account.kind='memory.identity.platform.account.entity'
     LEFT JOIN information_references observed_ref
       ON observed_ref.target_information_id=account.information_id
       AND observed_ref.relation='core:observes'
     LEFT JOIN information_atoms observed
       ON observed.information_id=observed_ref.information_id
       AND observed.kind='memory.identity.person.observed'
     WHERE binding.kind='memory.identity.platform.account.binding'
       AND ($1::text IS NULL OR account.payload->>'platform'=$1)
       AND ($2::text IS NULL OR
         POSITION(LOWER($2) IN LOWER(COALESCE(account.payload->>'accountId','')))>0 OR
         POSITION(LOWER($2) IN LOWER(COALESCE(observed.payload->>'nickname','')))>0 OR
         POSITION(LOWER($2) IN LOWER(COALESCE(observed.payload->>'card','')))>0)
     LIMIT 10001`,
    [options.platform ?? null, options.q ?? null],
  );
  return new Set(rows.rows.map((row) => row.person_information_id));
}

export async function readPrimaryAccounts(
  database: KaguyaDatabase,
  personInformationIds: readonly string[],
): Promise<Map<string, { platform: string; accountId: string }>> {
  if (!personInformationIds.length) return new Map();
  const rows = await database.sql.query<{
    person_information_id: string;
    platform: string;
    account_id: string;
  }>(
    `SELECT binding.payload->>'personInformationId' AS person_information_id,
       account.payload->>'platform' AS platform,
       account.payload->>'accountId' AS account_id
     FROM information_atoms binding
     JOIN information_references account_ref
       ON account_ref.information_id=binding.information_id
       AND account_ref.relation='core:binds'
     JOIN information_atoms account
       ON account.information_id=account_ref.target_information_id
       AND account.kind='memory.identity.platform.account.entity'
     WHERE binding.kind='memory.identity.platform.account.binding'
       AND binding.payload->>'personInformationId'=ANY($1::text[])
     ORDER BY binding.occurred_at, binding.information_id`,
    [[...personInformationIds]],
  );
  const result = new Map<string, { platform: string; accountId: string }>();
  for (const row of rows.rows)
    if (!result.has(row.person_information_id))
      result.set(row.person_information_id, {
        platform: row.platform,
        accountId: row.account_id,
      });
  return result;
}

export async function readPersonObservationIds(
  database: KaguyaDatabase,
  personInformationId: string,
  limit: number,
): Promise<string[]> {
  const rows = await database.sql.query<{ information_id: string }>(
    `SELECT observed.information_id
     FROM information_atoms observed
     JOIN information_references observed_ref
       ON observed_ref.information_id=observed.information_id
       AND observed_ref.relation='core:observes'
     JOIN information_lifecycle lifecycle
       ON lifecycle.information_id=observed.information_id
     WHERE observed.kind='memory.identity.person.observed'
       AND EXISTS (
         SELECT 1 FROM information_atoms binding
         JOIN information_references account_ref
           ON account_ref.information_id=binding.information_id
           AND account_ref.relation='core:binds'
         WHERE binding.kind='memory.identity.platform.account.binding'
           AND binding.payload->>'personInformationId'=$1
           AND account_ref.target_information_id=observed_ref.target_information_id
       )
     ORDER BY lifecycle.position DESC
     LIMIT $2`,
    [personInformationId, limit],
  );
  return rows.rows.map((row) => row.information_id);
}
