import { fileURLToPath } from "node:url";

import { KaguyaDatabase } from "@kaguya/database";
import { normalizeWebInboundMessage } from "@kaguya/platform-adapters";
import { KaguyaRuntime } from "@kaguya/runtime";

const defaultDatabasePath = fileURLToPath(
  new URL("../../../.data/kaguya-demo.sqlite", import.meta.url),
);
const databasePath =
  process.env.KAGUYA_DEMO_DATABASE_PATH?.trim() || defaultDatabasePath;

async function main(): Promise<void> {
  const runtime = new KaguyaRuntime({ databasePath });
  await runtime.start();
  const inbound = normalizeWebInboundMessage(
    {
      requestId: `demo-${Date.now()}`,
      text: "Is tonight good for watching the moon?",
    },
    { adapterId: "demo.web.main" },
  );
  if (inbound === undefined) {
    throw new Error("Demo web message is invalid");
  }
  const result = await runtime.dispatch({ kind: "platform", message: inbound });
  await runtime.close();

  const database = KaguyaDatabase.open(databasePath);
  try {
    console.log("message module pipeline: completed");
    console.log(`trace: ${result.traceId}`);
    console.log(`messages: ${database.messages.listRecent(100).length}`);
    console.log(
      `llm traces: ${database.llmTraces.listByTrace(result.traceId).length}`,
    );
  } finally {
    database.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
