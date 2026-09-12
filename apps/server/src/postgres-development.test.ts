/**
 * 功能概述：验证开发 PostgreSQL 准备、容器身份与 Profile 配置衔接。
 * 主要职责：模拟 Docker 命令与数据库预检；v3 回归验证启动拒绝旧配置且不改写文件、不触发数据库操作。
 * 代码库关系：覆盖 postgres-development 与 CLI 的测试清单，真实配置文件只写入临时目录。
 * 输入输出与副作用：记录命令和状态变化；afterEach 恢复 mock 并清理文件，不操作用户 Docker 数据。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { FileUserConfigManager } from "@kaguya/config";
import { KaguyaDatabase } from "@kaguya/database";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertPostgresTestManifestComplete,
  parsePostgresPort,
} from "./postgres-cli.js";
import {
  checkDevelopmentPostgres,
  checkManagedPostgresDatabase,
  checkPostgresTestDatabase,
  ensureDevelopmentPostgres,
  ensureManagedPostgres,
  MANAGED_POSTGRES_CONTAINER,
  MANAGED_POSTGRES_IMAGE,
  MANAGED_POSTGRES_VOLUME,
  managedConnectionUrl,
  PostgresDevelopmentError,
  readDevelopmentPostgresStatus,
  type CommandRunner,
} from "./postgres-development.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("managed PostgreSQL lifecycle", () => {
  it("creates the fixed PostgreSQL 17 container and keeps its named volume", async () => {
    const commands: string[][] = [];
    let created = false;
    let running = false;
    const runner: CommandRunner = async (_command, args) => {
      commands.push([...args]);
      if (args[0] === "info") return ok("29.0.0");
      if (args[0] === "volume") return ok(MANAGED_POSTGRES_VOLUME);
      if (args[0] === "container" && args[1] === "inspect") {
        return created
          ? ok(inspection(running ? "running" : "created", 55432))
          : failed();
      }
      if (args[0] === "container" && args[1] === "create") {
        created = true;
        return ok(MANAGED_POSTGRES_CONTAINER);
      }
      if (args[0] === "container" && args[1] === "start") {
        running = true;
        return ok(MANAGED_POSTGRES_CONTAINER);
      }
      if (args[0] === "container" && args[1] === "exec") return ok("ready");
      return failed();
    };

    const result = await ensureManagedPostgres({
      port: 55432,
      dependencies: { runCommand: runner, wait: async () => undefined },
    });

    expect(result).toEqual({
      port: 55432,
      databaseUrl: managedConnectionUrl(55432),
    });
    expect(commands).toContainEqual([
      "volume",
      "create",
      "--label",
      "dev.kaguya.postgres=17",
      MANAGED_POSTGRES_VOLUME,
    ]);
    const create = commands.find(
      ([scope, operation]) => scope === "container" && operation === "create",
    );
    expect(create).toEqual(
      expect.arrayContaining([
        MANAGED_POSTGRES_IMAGE,
        "127.0.0.1:55432:5432",
        `type=volume,source=${MANAGED_POSTGRES_VOLUME},target=/var/lib/postgresql/data`,
      ]),
    );
  });

  it("restarts a stopped matching container without creating another", async () => {
    const commands: string[][] = [];
    let running = false;
    const runner: CommandRunner = async (_command, args) => {
      commands.push([...args]);
      if (args[0] === "info") return ok("29.0.0");
      if (args[1] === "inspect") {
        return ok(inspection(running ? "running" : "exited", 5432));
      }
      if (args[1] === "start") {
        running = true;
        return ok(MANAGED_POSTGRES_CONTAINER);
      }
      if (args[1] === "exec") return ok("ready");
      return failed();
    };

    await ensureManagedPostgres({ dependencies: { runCommand: runner } });

    expect(commands.filter((args) => args[1] === "start")).toHaveLength(1);
    expect(commands.some((args) => args[1] === "create")).toBe(false);
    expect(commands.some((args) => args[0] === "volume")).toBe(false);
  });

  it("reuses an already running matching container on repeated starts", async () => {
    const commands: string[][] = [];
    const runner: CommandRunner = async (_command, args) => {
      commands.push([...args]);
      if (args[0] === "info") return ok("29.0.0");
      if (args[1] === "inspect") return ok(inspection("running", 5432));
      if (args[1] === "exec") return ok("ready");
      return failed();
    };

    await ensureManagedPostgres({ dependencies: { runCommand: runner } });
    await ensureManagedPostgres({ dependencies: { runCommand: runner } });

    expect(commands.some((args) => args[1] === "create")).toBe(false);
    expect(commands.some((args) => args[1] === "start")).toBe(false);
  });

  it("rejects a mismatched container without leaking Docker output", async () => {
    const secret = "postgresql://user:private-password@host/database";
    const runner: CommandRunner = async (_command, args) => {
      if (args[0] === "info") return ok("29.0.0");
      if (args[1] === "inspect") {
        return ok(
          [
            "postgres:16-alpine",
            "17",
            "running",
            "127.0.0.1",
            "5432",
            secret,
          ].join("\t"),
        );
      }
      return failed();
    };

    const error = await ensureManagedPostgres({
      dependencies: { runCommand: runner },
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PostgresDevelopmentError);
    expect(String(error)).not.toContain("private-password");
    expect(String(error)).not.toContain(secret);
  });

  it("rejects a port change without rebuilding the existing container", async () => {
    const commands: string[][] = [];
    const runner: CommandRunner = async (_command, args) => {
      commands.push([...args]);
      if (args[0] === "info") return ok("29.0.0");
      if (args[1] === "inspect") return ok(inspection("running", 5432));
      return failed();
    };

    await expect(
      ensureManagedPostgres({
        port: 55432,
        dependencies: { runCommand: runner },
      }),
    ).rejects.toThrow("does not match");
    expect(commands.some((args) => args[1] === "create")).toBe(false);
  });

  it("maps health timeouts to a stable redacted error", async () => {
    let readyCalls = 0;
    const runner: CommandRunner = async (_command, args) => {
      if (args[0] === "info") return ok("29.0.0");
      if (args[1] === "inspect") return ok(inspection("running", 5432));
      if (args[1] === "exec") {
        readyCalls += 1;
        return { exitCode: 1, stdout: "private-docker-password" };
      }
      return failed();
    };

    const error = await ensureManagedPostgres({
      dependencies: {
        runCommand: runner,
        wait: async () => undefined,
      },
    }).catch((thrown: unknown) => thrown);

    expect(readyCalls).toBe(120);
    expect(error).toBeInstanceOf(PostgresDevelopmentError);
    expect(String(error)).toContain("within 60 seconds");
    expect(String(error)).not.toContain("private-docker-password");
  });
});

describe("Profile-backed PostgreSQL selection", () => {
  it("writes a managed runtime into a fresh selected Profile", async () => {
    const root = await temporaryRoot();
    const initialManager = await FileUserConfigManager.bootstrap({
      rootDir: root,
    });
    const initialProfile = await initialManager.getProfile("default");
    await initialManager.replaceProfile("default", {
      name: initialProfile.name,
      acknowledgedWarnings: [],
      identity: initialProfile.identity,
      ai: {
        defaultProviderId: "provider-1",
        modelTiers: {
          light: { providerId: "provider-1", modelId: "light-model" },
          heavy: { providerId: "provider-1", modelId: "heavy-model" },
        },
        providers: [
          {
            id: "provider-1",
            type: "openai-compatible",
            enabled: true,
            apiKey: "test-only-placeholder",
            baseUrl: "https://model.example/v1",
            models: ["light-model", "heavy-model"],
            settings: {},
          },
        ],
      },
      memory: { enabled: true },
      platforms: [],
    });
    const runner = runningManagedRunner(5432);
    const databaseChecks: Array<{ url: string; prepareSchema: boolean }> = [];

    await ensureDevelopmentPostgres({
      configRoot: root,
      dependencies: {
        runCommand: runner,
        checkDatabase: async (url, { prepareSchema }) => {
          databaseChecks.push({ url, prepareSchema });
        },
      },
    });

    const manager = await FileUserConfigManager.open({ rootDir: root });
    const profile = await manager.getProfile(manager.getSelectedProfileId());
    expect(profile.runtime).toMatchObject({
      databaseMode: "managed",
      databaseUrl: managedConnectionUrl(5432),
      host: "127.0.0.1",
      port: 3000,
    });
    expect(profile.ai).toEqual(
      expect.objectContaining({ defaultProviderId: "provider-1" }),
    );
    expect(profile.memory).toEqual({ enabled: true });
    expect(profile.platforms).toEqual([]);
    expect(profile.review).toBeUndefined();
    expect(databaseChecks).toEqual([
      { url: managedConnectionUrl(5432), prepareSchema: true },
    ]);
  });

  it("never calls Docker for an external selected Profile", async () => {
    const root = await temporaryRoot();
    const manager = await FileUserConfigManager.bootstrap({ rootDir: root });
    const profile = await manager.getProfile(manager.getSelectedProfileId());
    const externalUrl = "postgresql://external:secret@database.example/kaguya";
    await manager.replaceProfile(profile.id, {
      name: profile.name,
      acknowledgedWarnings: [],
      identity: profile.identity,
      ai: profile.ai,
      memory: profile.memory,
      platforms: profile.platforms,
      runtime: runtime(externalUrl, "external"),
    });
    let dockerCalls = 0;
    let checked = "";

    const result = await ensureDevelopmentPostgres({
      configRoot: root,
      dependencies: {
        runCommand: async () => {
          dockerCalls += 1;
          return failed();
        },
        checkDatabase: async (url) => {
          checked = url;
        },
      },
    });

    expect(result.mode).toBe("external");
    await expect(
      readDevelopmentPostgresStatus({
        configRoot: root,
        dependencies: {
          runCommand: async () => {
            dockerCalls += 1;
            return failed();
          },
          checkDatabase: async () => undefined,
        },
      }),
    ).resolves.toMatchObject({
      mode: "external",
      status: { state: "external", healthy: true, postgresMajor: 17 },
    });
    await expect(
      checkDevelopmentPostgres({
        configRoot: root,
        dependencies: {
          runCommand: async () => {
            dockerCalls += 1;
            return failed();
          },
          checkDatabase: async () => undefined,
        },
      }),
    ).resolves.toMatchObject({ mode: "external" });
    expect(checked).toBe(externalUrl);
    expect(dockerCalls).toBe(0);
  });

  it("does not overwrite a partially invalid runtime", async () => {
    const root = await temporaryRoot();
    await FileUserConfigManager.bootstrap({ rootDir: root });
    const profilePath = join(root, "profiles", "profile_default.json");
    const profile = JSON.parse(await readFile(profilePath, "utf8")) as Record<
      string,
      unknown
    >;
    profile.runtime = { host: "127.0.0.1", databaseUrl: "private-value" };
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
    let dockerCalls = 0;

    await expect(
      ensureDevelopmentPostgres({
        configRoot: root,
        dependencies: {
          runCommand: async () => {
            dockerCalls += 1;
            return failed();
          },
        },
      }),
    ).rejects.toBeDefined();
    expect(dockerCalls).toBe(0);
    expect(await readFile(profilePath, "utf8")).toContain("private-value");
  });

  it("keeps status read-only and check refuses a stopped managed container", async () => {
    const root = await configuredManagedRoot();
    const commands: string[][] = [];
    const runner: CommandRunner = async (_command, args) => {
      commands.push([...args]);
      if (args[0] === "info") return ok("29.0.0");
      if (args[1] === "inspect") return ok(inspection("exited", 5432));
      return failed();
    };

    const status = await readDevelopmentPostgresStatus({
      configRoot: root,
      dependencies: { runCommand: runner },
    });
    expect(status.status).toMatchObject({ state: "stopped", healthy: false });
    expect(commands.some((args) => args[1] === "start")).toBe(false);
    await expect(
      checkDevelopmentPostgres({
        configRoot: root,
        dependencies: { runCommand: runner },
      }),
    ).rejects.toThrow("not running");
  });
});

it("redacts database driver failures", async () => {
  vi.spyOn(KaguyaDatabase, "connect").mockRejectedValueOnce(
    new Error("postgresql://user:private-password@database.example/kaguya"),
  );

  const error = await checkPostgresTestDatabase(
    "postgresql://user:another-secret@database.example/kaguya",
  ).catch((thrown: unknown) => thrown);

  expect(error).toBeInstanceOf(PostgresDevelopmentError);
  expect(String(error)).toBe(
    "PostgresDevelopmentError: PostgreSQL readiness check failed",
  );
  expect(String(error)).not.toContain("password");
  expect(String(error)).not.toContain("another-secret");
});

it("retries the managed host connection after container readiness", async () => {
  let checks = 0;
  let waits = 0;

  await checkManagedPostgresDatabase(
    managedConnectionUrl(55432),
    { prepareSchema: false },
    {
      checkDatabase: async () => {
        checks += 1;
        if (checks < 3) throw new Error("not exposed");
      },
      wait: async () => {
        waits += 1;
      },
    },
  );

  expect(checks).toBe(3);
  expect(waits).toBe(2);
});

it("registers every test suite that consumes the PostgreSQL test URL", async () => {
  await expect(
    assertPostgresTestManifestComplete(
      fileURLToPath(new URL("../../..", import.meta.url)),
    ),
  ).resolves.toBeUndefined();
});

it("accepts the pnpm argument separator before a port override", () => {
  expect(parsePostgresPort(["--", "--port", "55432"])).toBe(55432);
  expect(parsePostgresPort(["--port", "5433"])).toBe(5433);
  expect(() => parsePostgresPort(["--", "--port", "0"])).toThrow(
    "integer from 1 to 65535",
  );
});

function ok(stdout = ""): { exitCode: number; stdout: string } {
  return { exitCode: 0, stdout };
}

function failed(): { exitCode: number; stdout: string } {
  return { exitCode: 1, stdout: "private Docker failure" };
}

function inspection(state: string, port: number): string {
  return [
    MANAGED_POSTGRES_IMAGE,
    "17",
    state,
    "127.0.0.1",
    String(port),
    MANAGED_POSTGRES_VOLUME,
  ].join("\t");
}

function runningManagedRunner(port: number): CommandRunner {
  return async (_command, args) => {
    if (args[0] === "info") return ok("29.0.0");
    if (args[1] === "inspect") return ok(inspection("running", port));
    if (args[1] === "exec") return ok("ready");
    return failed();
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kaguya-postgres-development-"));
  roots.push(root);
  return root;
}

async function configuredManagedRoot(): Promise<string> {
  const root = await temporaryRoot();
  const manager = await FileUserConfigManager.bootstrap({ rootDir: root });
  const profile = await manager.getProfile(manager.getSelectedProfileId());
  await manager.replaceProfile(profile.id, {
    name: profile.name,
    acknowledgedWarnings: [],
    identity: profile.identity,
    ai: profile.ai,
    memory: profile.memory,
    platforms: profile.platforms,
    runtime: runtime(managedConnectionUrl(5432), "managed"),
  });
  return root;
}

function runtime(databaseUrl: string, databaseMode: "managed" | "external") {
  return {
    host: "127.0.0.1",
    port: 3000,
    databaseMode,
    databaseUrl,
    webDistPath: "apps/web/dist",
    corsOrigins: [],
    trustProxy: false as const,
    rateLimitMax: 30,
    rateLimitWindowMs: 60_000,
    logLevel: "info" as const,
    logFormat: "pretty" as const,
    gatewayAllowlist: [],
  };
}

it("rejects a v3 registry without rewriting it during database preparation", async () => {
  const root = await configuredManagedRoot();
  const indexPath = join(root, "index.json");
  const profilePath = join(root, "profiles", "profile_default.json");
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  const profile = JSON.parse(await readFile(profilePath, "utf8"));
  index.version = 3;
  profile.plugins = [];
  delete profile.identity;
  delete profile.memory;
  delete profile.runtime.databaseMode;
  await writeFile(indexPath, JSON.stringify(index));
  await writeFile(profilePath, JSON.stringify(profile));
  const checkDatabase = vi.fn(async () => undefined);
  const runCommand = vi.fn(async () => failed());
  await expect(
    ensureDevelopmentPostgres({
      configRoot: root,
      dependencies: { checkDatabase, runCommand },
    }),
  ).rejects.toMatchObject({ code: "CONFIG_CORRUPT_STORE" });
  expect(runCommand).not.toHaveBeenCalled();
  expect(checkDatabase).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(indexPath, "utf8"))).toEqual(index);
  expect(JSON.parse(await readFile(profilePath, "utf8"))).toEqual(profile);
});
