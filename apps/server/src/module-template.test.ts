/**
 * 功能概述：验证真实模板文件的本地覆盖、恢复、整组校验与并发保护。
 * 主要职责：复制全部受版本控制的默认模板构造临时 Catalog，拒绝未知变量/helper/partial、空白、语法及循环；
 * 精确核对包含冷启动策略的 Heartflow 模板目录；确认校验失败不写文件，默认模板字节不变、源码来源可追踪，错误不泄露模板片段。
 * 代码库关系：直接驱动 ModuleTemplateManagement 与模块 Node 存储；运行模板加载器验证消费覆盖。
 * 输入输出与副作用：只操作临时目录，不调用模型、重启或发送消息。
 */
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import {
  mkdtemp,
  copyFile,
  readFile,
  rm,
  symlink,
  writeFile,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import type { InformationModuleCatalog } from "@kaguya/sdk";
import { createMessageCatalog } from "@kaguya/composition";
import { loadFirstPartyPromptTemplates } from "@kaguya/modules/prompt-templates/node";
import { ModuleTemplateManagement } from "./module-template-management.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

// Windows 普通进程可能没有创建符号链接的权限（未开启 Developer Mode），
// 此时依赖 symlink 夹具的用例无法构造前置条件，在收集期探测并跳过。
function canCreateSymlinks(): boolean {
  let root: string | undefined;
  try {
    root = mkdtempSync(join(tmpdir(), "kaguya-symlink-probe-"));
    symlinkSync(join(root, "target"), join(root, "link"));
    return true;
  } catch {
    return false;
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
  }
}

async function fixture(cyclic = false) {
  const path = await mkdtemp(join(tmpdir(), "module-templates-"));
  roots.push(path);
  const root = pathToFileURL(`${path}/`);
  const original: InformationModuleCatalog = createMessageCatalog();
  const catalog = {
    definitions: original.definitions.map((d) =>
      !cyclic || d.manifest.definitionId !== "agent.message-composer"
        ? d
        : {
            ...d,
            manifest: {
              ...d.manifest,
              promptTemplates: d.manifest.promptTemplates!.map((t) =>
                t.name !== "history-inbound"
                  ? t
                  : { ...t, allowedPartials: ["history"] },
              ),
            },
          },
    ),
  };
  const templatesPath = join(process.cwd(), "packages/modules/templates");
  for (const file of (await readdir(templatesPath)).filter((name) =>
    name.endsWith(".default.hbs"),
  ))
    await copyFile(join(templatesPath, file), join(path, file));
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(op: () => Promise<T>) => {
    const result = tail.then(op, op);
    tail = result.catch(() => undefined);
    return result;
  };
  return {
    path,
    root,
    service: new ModuleTemplateManagement({ catalog, root, exclusive }),
  };
}
it("saves a validated local override, runtime loads it, and restores unchanged default bytes", async () => {
  const { service, path, root } = await fixture();
  const id = "agent.message-composer";
  const tid = "message-composer";
  const before = await readFile(join(path, `${tid}.default.hbs`), "utf8");
  const first = service.get(id);
  expect(first.templates[0]!.source).toBe("default");
  const saved = await service.change(id, tid, {
    revision: first.revision,
    content: "LOCAL {{name}}",
  });
  expect(saved.templates[0]).toMatchObject({
    source: "local",
    content: "LOCAL {{name}}",
  });
  expect(loadFirstPartyPromptTemplates({ root }).messageComposer.main).toBe(
    "LOCAL {{name}}",
  );
  expect(
    (await service.change(id, tid, { revision: saved.revision }, true))
      .templates[0]!.source,
  ).toBe("default");
  expect(await readFile(join(path, `${tid}.default.hbs`), "utf8")).toBe(before);
  await expect(readFile(join(path, `${tid}.local.hbs`))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
it("rejects invalid sources before writing and never echoes parser source", async () => {
  const { service, path } = await fixture();
  const id = "agent.message-composer";
  const revision = service.get(id).revision;
  for (const [content, code] of [
    ["{{SECRET_UNKNOWN}}", "unknown_variable"],
    ["{{> missing}}", "invalid_partial"],
    ["{{> (lookup x y)}}", "invalid_partial"],
    ["{{#with name}}x{{/with}}", "unsupported_helper"],
    [" \n\t", "empty_template"],
    ["{{#if name}} SECRET_PARSE_SNIPPET", "invalid_syntax"],
  ]) {
    await expect(
      service.change(id, "message-composer", { revision, content }),
    ).rejects.toMatchObject({ status: 400, code });
    expect(service.get(id).revision).toBe(revision);
    await expect(
      readFile(join(path, "message-composer.local.hbs")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }
});
it("validates cyclic partials across the group before saving", async () => {
  const { service } = await fixture(true);
  const id = "agent.message-composer";
  await expect(
    service.change(id, "message-composer.history-inbound", {
      revision: service.get(id).revision,
      content: "{{> history}}",
    }),
  ).rejects.toMatchObject({ status: 400, code: "recursive_partial" });
});
it("group CAS rejects a second editor even when it writes a different template", async () => {
  const { service, path } = await fixture();
  const id = "agent.message-composer";
  const revision = service.get(id).revision;
  const results = await Promise.allSettled([
    service.change(id, "message-composer", { revision, content: "valid" }),
    service.change(id, "message-composer.turn", { revision, content: "other" }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({
    reason: { status: 409 },
  });
  await expect(
    readFile(join(path, "message-composer.turn.local.hbs")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
it.runIf(canCreateSymlinks())(
  "enforces ownership, rejects symlinks and exposes only declared static sources",
  async () => {
    const { service, path } = await fixture();
    expect(
      service.get("agent.heartflow.online").templates.map((t) => t.templateId),
    ).toEqual([
      "heartflow.planner",
      "heartflow.bootstrap-policy",
      "heartflow.platform-policy",
      "heartflow.platform-policy-qq",
      "heartflow.platform-policy-web",
    ]);
    expect(service.get("agent.memory.cognition").templates).toEqual([]);
    await expect(
      service.change("agent.heartflow.online", "message-composer", {
        revision: "anything",
        content: "x",
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.change("agent.message-composer", "../escape", {
        revision: "anything",
        content: "x",
      }),
    ).rejects.toMatchObject({ status: 404 });
    const target = join(path, "secret.txt");
    await writeFile(target, "SENSITIVE_FILE");
    await symlink(target, join(path, "message-composer.local.hbs"));
    expect(() => service.get("agent.message-composer")).toThrow();
    expect(await readFile(target, "utf8")).toBe("SENSITIVE_FILE");
  },
);
it("planner override is consumed by the production template loader", async () => {
  const { service, root } = await fixture();
  const id = "agent.heartflow.online";
  await service.change(id, "heartflow.planner", {
    revision: service.get(id).revision,
    content: "Planner {{identity}} {{turn}}",
  });
  expect(loadFirstPartyPromptTemplates({ root }).planner).toBe(
    "Planner {{identity}} {{turn}}",
  );
});

it("authenticates template routes and sanitizes invalid syntax responses", async () => {
  const { service } = await fixture();
  const { createHttpApplication } = await import("./app.js");
  const app = await createHttpApplication({
    moduleTemplates: service,
    config: {
      host: "127.0.0.1",
      port: 3000,
      gatewayToken: "test-template-token-12345",
      corsOrigins: [],
      trustProxy: false,
      rateLimitMax: 100,
      rateLimitWindowMs: 60000,
      databaseUrl: "postgresql://localhost/test",
      configRoot: "/tmp/test",
      development: false,
      webDistPath: "/tmp/web",
      logLevel: "silent",
      logFormat: "json",
      inboundAllowlist: [],
      outboundAllowlist: [],
      napcat: {
        enabled: false,
        adapterId: "napcat.qq.main",
        reconnectMs: 3000,
      },
    },
  });
  const url = "/api/v1/modules/agent.message-composer/templates";
  const headers = { authorization: "Bearer test-template-token-12345" };
  try {
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      const response = await app.inject({
        method,
        url: method === "GET" ? url : `${url}/message-composer`,
        ...(method === "GET" ? {} : { payload: {} }),
      });
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain("{{persona}}");
    }
    const read = await app.inject({ method: "GET", url, headers });
    expect(read.statusCode).toBe(200);
    expect(read.headers["cache-control"]).toBe("no-store");
    const result = await app.inject({
      method: "PUT",
      url: `${url}/message-composer`,
      headers,
      payload: {
        revision: read.json().data.revision,
        content: "{{#if name}} SECRET_PARSER_CONTENT",
      },
    });
    expect(result.statusCode).toBe(400);
    expect(result.json().error.code).toBe("invalid_syntax");
    expect(result.body).not.toContain("SECRET_PARSER_CONTENT");
    const oversized = await app.inject({
      method: "PUT",
      url: `${url}/message-composer`,
      headers,
      payload: {
        revision: read.json().data.revision,
        content: "字".repeat(50000),
      },
    });
    expect(oversized.statusCode).toBe(400);
    expect(oversized.json().error.code).toBe("template_too_large");
  } finally {
    await app.close();
  }
});

it.each(["expression.learn", "expression.select"])(
  "expression override %s is loaded and reset without changing defaults",
  async (tid) => {
    const { service, root, path } = await fixture();
    const id = "agent.expression";
    const before = await readFile(join(path, `${tid}.default.hbs`), "utf8");
    const saved = await service.change(id, tid, {
      revision: service.get(id).revision,
      content: "CUSTOM {{context}}",
    });
    expect(
      loadFirstPartyPromptTemplates({ root }).expression[
        tid === "expression.learn" ? "learn" : "select"
      ],
    ).toBe("CUSTOM {{context}}");
    await service.change(id, tid, { revision: saved.revision }, true);
    expect(await readFile(join(path, `${tid}.default.hbs`), "utf8")).toBe(
      before,
    );
    expect(
      service.get(id).templates.find((t) => t.templateId === tid)!.source,
    ).toBe("default");
  },
);
