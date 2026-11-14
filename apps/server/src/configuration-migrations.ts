/**
 * Runs ordered, restartable first-party configuration migrations before strict
 * startup loading. Offline apply uses the same path without starting Runtime.
 * The Lifecycle stage uses its original module set, then continuity is added
 * disabled. Neither stage changes Profile settings or enables autonomous work.
 */
import {
  migrateContinuityConfig,
  migrateLifecycleConfig,
  type ModuleInstanceConfig,
} from "@kaguya/config";
import { lifecycleSettingsSchema } from "@kaguya/modules";

export async function migrateFirstPartyConfig(
  rootDir: string,
  defaults: readonly ModuleInstanceConfig[],
): Promise<void> {
  await migrateLifecycleConfig(
    rootDir,
    defaults.filter((item) => item.definitionId !== "agent.continuity"),
    lifecycleSettingsSchema,
  );
  await migrateContinuityConfig(rootDir, defaults);
}
