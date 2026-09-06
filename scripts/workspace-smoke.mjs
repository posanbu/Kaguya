import { readFile } from "node:fs/promises";

const root = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const expected = ["build", "typecheck", "lint", "test", "prompt:test", "demo"];
for (const script of expected) {
  if (!root.scripts?.[script]) {
    throw new Error(`missing root script: ${script}`);
  }
}
