/** 导出框架无关数据契约。--check 只检查，不改写文件。 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { format } from "prettier";
import { situationContractSchema } from "../packages/schema/src/situation-contract.js";

const directory = new URL("../contracts/situation-action/v1/", import.meta.url);
const schema = await format(
  JSON.stringify(
    {
      ...situationContractSchema.toJSONSchema({
        target: "draft-2020-12",
        reused: "inline",
      }),
      $id: "https://kaguya.local/contracts/situation-action/1.0.0",
    },
    null,
    2,
  ),
  { parser: "json" },
);
const types = readFileSync(new URL("types.ts", directory), "utf8");
const outputs = new Map([
  [new URL("schema.json", directory), schema],
  [
    new URL("../packages/schema/src/situation-context.ts", import.meta.url),
    types,
  ],
]);
const digest = createHash("sha256");
for (const [name, content] of [
  ["types.ts", types],
  ["schema.json", schema],
  [
    "scenarios.json",
    readFileSync(new URL("scenarios.json", directory), "utf8"),
  ],
]) {
  digest.update(name! + "\0" + content! + "\0");
}
outputs.set(
  new URL("manifest.json", directory),
  await format(
    JSON.stringify(
      {
        contractVersion: "1.0.0",
        sha256: digest.digest("hex"),
        files: ["types.ts", "schema.json", "scenarios.json"],
      },
      null,
      2,
    ),
    { parser: "json" },
  ),
);
for (const [url, content] of outputs) {
  if (process.argv.includes("--check")) {
    if (readFileSync(url, "utf8") !== content)
      throw new Error(`Stale situation contract: ${fileURLToPath(url)}`);
  } else writeFileSync(url, content);
}
console.log("situation-action 1.0.0: contract artifacts verified");
