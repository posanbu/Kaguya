import { fileURLToPath } from "node:url";

import { KaguyaDatabase } from "@kaguya/database";
import { KaguyaRuntime } from "@kaguya/runtime";

const databasePath = fileURLToPath(
  new URL("../../../.data/kaguya-demo.sqlite", import.meta.url),
);

async function main(): Promise<void> {
  const runtime = new KaguyaRuntime({ databasePath });
  await runtime.start();
  const result = await runtime.dispatch({
    kind: "web",
    requestId: `demo-${Date.now()}`,
    // Kept only as an opaque Web source value for API compatibility.
    sessionId: "demo-source",
    text: "Is tonight good for watching the moon?",
  });
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
