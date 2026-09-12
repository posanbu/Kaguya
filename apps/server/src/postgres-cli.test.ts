/**
 * 功能概述：验证开发 CLI 的数据库失败降级、Docker 启动指引与配置错误阻断。
 * 主要职责：runPostgresCli 测试模拟子进程和准备结果，断言命令、退出码及安全诊断。
 * 代码库关系：覆盖 postgres-cli 与 postgres-development 契约；不启动真实 Docker 或 Server。
 * 输入输出与副作用：捕获 stderr 和 spawn 调用，每例恢复 spy，不输出虚构凭据。
 */
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { ConfigError } from "@kaguya/config";
import {
  ensureDevelopmentPostgres,
  PostgresDevelopmentError,
} from "./postgres-development.js";
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
it("continues development startup after a classified database failure", async () => {
  vi.mocked(ensureDevelopmentPostgres).mockRejectedValueOnce(
    new PostgresDevelopmentError("PostgreSQL readiness check failed"),
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
  const diagnostic = output.mock.calls.map(([text]) => text).join("");
  expect(diagnostic).toContain("Database preparation unavailable");
  expect(diagnostic).toContain("open -a Docker");
  expect(diagnostic).toContain("docker info");
  expect(diagnostic).toContain("pnpm dev");
});
it("reports configuration diagnostics and does not spawn the Server", async () => {
  vi.mocked(ensureDevelopmentPostgres).mockRejectedValueOnce(
    new ConfigError(
      "CONFIG_CORRUPT_STORE",
      "Configuration profile failed validation",
      {
        validationIssues: [
          {
            code: "invalid_type",
            path: "runtime.gatewayAllowlist",
            message: "Expected an array of strings.",
            hint: "Use platform:group|private:target-id rules.",
          },
        ],
      },
    ),
  );
  const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  await expect(runPostgresCli(["dev"])).resolves.toBe(1);

  const diagnostic = output.mock.calls.map(([text]) => text).join("");
  expect(diagnostic).toContain("Configuration preparation failed");
  expect(diagnostic).toContain("CONFIG_CORRUPT_STORE");
  expect(diagnostic).toContain("runtime.gatewayAllowlist");
  expect(spawn).not.toHaveBeenCalled();
});
it("stops on an unknown non-database preparation failure without leaking it", async () => {
  vi.mocked(ensureDevelopmentPostgres).mockRejectedValueOnce(
    new Error("postgresql://user:credential-secret@localhost/kaguya"),
  );
  const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  await expect(runPostgresCli(["dev"])).resolves.toBe(1);

  const diagnostic = output.mock.calls.map(([text]) => text).join("");
  expect(diagnostic).toContain("Development preparation failed [UnknownError]");
  expect(diagnostic).not.toContain("credential-secret");
  expect(spawn).not.toHaveBeenCalled();
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
