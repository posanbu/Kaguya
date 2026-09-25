/**
 * 功能概述：增量安装持续观察的场景登记、独立消费进度及不可变输入快照。
 * prepareObservationSchema 在基础 ledger/lifecycle 之后运行，DDL 可重复执行，不重写旧 Information 或 scope。
 * 代码库关系：KaguyaDatabase.prepareSchema 调用；PostgresObservationStore 在事务中维护快照与进度。
 * 输入输出与副作用：仅建立附加表/索引；来源依旧由 information_atoms 持有，停用消费者保留其快照和进度。
 */
import type { SqlDatabase } from "./driver.js";
export async function prepareObservationSchema(db: SqlDatabase): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(168247)");
    await tx.exec(`
      CREATE TABLE IF NOT EXISTS information_scenes (
        scene_id text PRIMARY KEY, address jsonb NOT NULL,
        legacy_scope_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE TABLE IF NOT EXISTS information_observation_progress (
        stream_id text PRIMARY KEY, scene_id text NOT NULL REFERENCES information_scenes(scene_id),
        consumer_id text NOT NULL, policy_version text NOT NULL, contract jsonb NOT NULL,
        through_position bigint NOT NULL DEFAULT 0, latest_observation_id text
      );
      CREATE TABLE IF NOT EXISTS information_observations (
        observation_id text PRIMARY KEY,
        stream_id text NOT NULL REFERENCES information_observation_progress(stream_id),
        after_position bigint NOT NULL, through_position bigint NOT NULL,
        source_ids jsonb NOT NULL, context_ids jsonb NOT NULL, has_more boolean NOT NULL,
        recorded_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
        status text NOT NULL DEFAULT 'frozen' CHECK(status IN ('frozen','completed','failed')),
        result_information_id text REFERENCES information_atoms(information_id), error_code text,
        CHECK(through_position > after_position),
        UNIQUE(stream_id, after_position)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS information_observations_open_idx
        ON information_observations(stream_id) WHERE status <> 'completed';
      CREATE INDEX IF NOT EXISTS information_observations_scene_idx
        ON information_observations(stream_id, through_position DESC);
    `);
  });
}
