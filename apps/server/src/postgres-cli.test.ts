/**
 * 测试配置分别声明 inboundAllowlist/outboundAllowlist，保持与严格 Profile 或 Runtime 出站策略契约一致。
 * 功能概述：验证开发 CLI 的数据库失败降级、Docker 启动指引与配置错误阻断。
 * 主要职责：模拟数据库准备并验证进程、退出码与安全诊断；真实 tsx/Vitest 子进程验证无 pnpm 启动。
 * 代码库关系：覆盖 postgres-cli 与 postgres-development 契约；不启动真实 Docker 或 Server。
 * 输入输出与副作用：捕获 stderr 和 spawn，在临时目录检查参数及环境，每例清理进程监听与文件。
 */
import { ChildProcess, spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { ConfigError } from "@kaguya/config";
import {
  checkManagedPostgresDatabase,
  ensureDevelopmentPostgres,
  ensureManagedPostgres,
  PostgresDevelopmentError,
} from "./postgres-development.js";
import {
  POSTGRES_TEST_FILES,
  runNodeCli,
  runPostgresCli,
} from "./postgres-cli.js";
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const child = Object.assign(new actual.ChildProcess(), { kill: vi.fn() });
      queueMicrotask(() => child.emit("close", 0));
      return child;
    }),
  };
});
vi.mock("./postgres-development.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./postgres-development.js")>()),
  ensureDevelopmentPostgres: vi.fn(),
  ensureManagedPostgres: vi.fn(),
  checkManagedPostgresDatabase: vi.fn(),
}));
const temporaryDirectories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
it("continues development startup after a classified database failure", async () => {
  vi.mocked(ensureDevelopmentPostgres).mockRejectedValueOnce(
    new PostgresDevelopmentError("PostgreSQL readiness check failed"),
  );
  const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  await expect(runPostgresCli(["dev"])).resolves.toBe(0);
  expect(spawn).toHaveBeenCalledWith(
    process.execPath,
    [fileURLToPath(import.meta.resolve("tsx/cli")), "src/server.ts"],
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
            path: "runtime.inboundAllowlist",
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
  expect(diagnostic).toContain("runtime.inboundAllowlist");
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

it("runs PostgreSQL tests through the installed Vitest entrypoint", async () => {
  // Keep the test-only URL out of the parent process and never connect to a database.
  vi.stubEnv(["KAGUYA", "TEST", "DATABASE", "URL"].join("_"), "");
  vi.mocked(ensureManagedPostgres).mockResolvedValueOnce({
    databaseUrl: "postgresql://test:test@127.0.0.1:5432/test",
    port: 5432,
  });

  await expect(runPostgresCli(["test"])).resolves.toBe(0);

  expect(checkManagedPostgresDatabase).toHaveBeenCalledWith(
    "postgresql://test:test@127.0.0.1:5432/test",
    { prepareSchema: false },
  );
  expect(spawn).toHaveBeenCalledWith(
    process.execPath,
    [
      fileURLToPath(
        new URL("./vitest.mjs", import.meta.resolve("vitest/package.json")),
      ),
      "run",
      ...POSTGRES_TEST_FILES,
    ],
    expect.objectContaining({
      cwd: fileURLToPath(new URL("../../../", import.meta.url)).replace(
        /[\\/]$/u,
        "",
      ),
      env: expect.objectContaining({ KAGUYA_REQUIRE_POSTGRES_TESTS: "1" }),
      stdio: "inherit",
    }),
  );
});

it.each(["synchronous", "asynchronous"])(
  "classifies %s launch failures without leaking process arguments",
  async (mode) => {
    const error = new Error("credential-secret");
    if (mode === "synchronous") {
      vi.mocked(spawn).mockImplementationOnce(() => {
        throw error;
      });
    } else {
      vi.mocked(spawn).mockImplementationOnce(() => {
        const child = Object.assign(new ChildProcess(), { kill: vi.fn() });
        queueMicrotask(() => child.emit("error", error));
        return child as ReturnType<typeof spawn>;
      });
    }
    const interruptListeners = process.listenerCount("SIGINT");
    const terminateListeners = process.listenerCount("SIGTERM");

    await expect(runPostgresCli(["dev"])).rejects.toThrow(
      new PostgresDevelopmentError("Child process could not be started"),
    );

    expect(process.listenerCount("SIGINT")).toBe(interruptListeners);
    expect(process.listenerCount("SIGTERM")).toBe(terminateListeners);
  },
);

it("forwards interruption and termination and removes handlers after child exit", async () => {
  const child = Object.assign(new ChildProcess(), { kill: vi.fn() });
  vi.mocked(spawn).mockReturnValueOnce(child as ReturnType<typeof spawn>);
  const originalInterrupts = process.listeners("SIGINT");
  const originalTerminates = process.listeners("SIGTERM");
  const result = runNodeCli("unused.mjs", [], process.cwd(), process.env);
  const interrupt = process
    .listeners("SIGINT")
    .find((listener) => !originalInterrupts.includes(listener));
  const terminate = process
    .listeners("SIGTERM")
    .find((listener) => !originalTerminates.includes(listener));

  expect(interrupt).toBeDefined();
  expect(terminate).toBeDefined();
  interrupt!("SIGINT");
  terminate!("SIGTERM");
  expect(child.kill.mock.calls).toEqual([["SIGINT"], ["SIGTERM"]]);
  child.emit("close", 7);

  await expect(result).resolves.toBe(7);
  expect(process.listeners("SIGINT")).toEqual(originalInterrupts);
  expect(process.listeners("SIGTERM")).toEqual(originalTerminates);
});

it("reports a signal-only child exit as unsuccessful", async () => {
  vi.mocked(spawn).mockImplementationOnce(() => {
    const child = Object.assign(new ChildProcess(), { kill: vi.fn() });
    queueMicrotask(() => child.emit("close", null, "SIGTERM"));
    return child as ReturnType<typeof spawn>;
  });
  await expect(
    runNodeCli("unused.mjs", [], process.cwd(), process.env),
  ).resolves.toBe(1);
});

it.each(["direct", "directory alias"])(
  "runs real tsx with spaces and shell metacharacters without pnpm on PATH (%s)",
  async (mode) => {
    const actual =
      await vi.importActual<typeof import("node:child_process")>(
        "node:child_process",
      );
    vi.mocked(spawn).mockImplementationOnce(actual.spawn);
    const root = await mkdtemp(join(tmpdir(), "kaguya cli (spaces) "));
    temporaryDirectories.push(root);
    const workingDirectory = join(root, "working directory");
    await mkdir(workingDirectory);
    const directory =
      mode === "direct" ? workingDirectory : join(root, "alias");
    if (mode !== "direct")
      await symlink(
        workingDirectory,
        directory,
        process.platform === "win32" ? "junction" : "dir",
      );
    const script = join(directory, "probe (entry).ts");
    const output = join(directory, "result.json");
    const args = ["value with spaces", "& echo unexpected", "%PATH%", "中文"];
    await writeFile(
      script,
      `import { writeFileSync } from "node:fs";
const value: string = "typed";
writeFileSync(process.argv[2]!, JSON.stringify({ args: process.argv.slice(3), cwd: process.cwd(), value, environment: process.env.KAGUYA_CLI_PROBE }));
process.exitCode = 7;
`,
    );

    await expect(
      runNodeCli(
        fileURLToPath(import.meta.resolve("tsx/cli")),
        [script, output, ...args],
        directory,
        { ...process.env, PATH: "", KAGUYA_CLI_PROBE: "inherited" },
      ),
    ).resolves.toBe(7);
    const { cwd, ...result } = JSON.parse(await readFile(output, "utf8"));
    expect(await realpath(cwd)).toBe(await realpath(directory));
    expect(result).toEqual({
      args,
      value: "typed",
      environment: "inherited",
    });
  },
);

it("runs the real Vitest CLI without pnpm on PATH", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  vi.mocked(spawn).mockImplementationOnce(actual.spawn);
  await expect(
    runNodeCli(
      fileURLToPath(
        new URL("./vitest.mjs", import.meta.resolve("vitest/package.json")),
      ),
      ["--version"],
      process.cwd(),
      { ...process.env, PATH: "" },
    ),
  ).resolves.toBe(0);
});
