/** Development startup must reach Server even if optional database preparation fails. */
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { ensureDevelopmentPostgres } from "./postgres-development.js";
import { runPostgresCli } from "./postgres-cli.js";
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    queueMicrotask(() => child.emit("close", 0));
    return child;
  }),
}));
vi.mock("./postgres-development.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./postgres-development.js")>()),
  ensureDevelopmentPostgres: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
it("continues development startup and does not print the database error", async () => {
  vi.mocked(ensureDevelopmentPostgres).mockRejectedValueOnce(
    new Error("postgresql://credential-secret"),
  );
  const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  await expect(runPostgresCli(["dev"])).resolves.toBe(0);
  expect(spawn).toHaveBeenCalledWith(
    expect.any(String),
    ["exec", "tsx", "src/server.ts"],
    expect.objectContaining({
      env: expect.objectContaining({ NODE_ENV: "development" }),
    }),
  );
  expect(output.mock.calls.map(([text]) => text).join("")).not.toContain(
    "credential-secret",
  );
});
it("keeps the explicit database start command strict", async () => {
  vi.mocked(ensureDevelopmentPostgres).mockRejectedValueOnce(
    new Error("database unavailable"),
  );
  await expect(runPostgresCli(["start"])).rejects.toThrow(
    "database unavailable",
  );
  expect(spawn).not.toHaveBeenCalled();
});
