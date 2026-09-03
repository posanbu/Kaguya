/**
 * 功能概述：验证 Server Gateway 凭据的持久化边界，确保正式 Token 只能通过
 * 不可逆校验值恢复验证，不能从配置文件中读回明文。
 * 主要职责：覆盖首次签发、正确/错误 Token 校验，以及凭据文件不包含明文；
 * 这些测试约束后续认证层使用的最小接口和失败行为。
 * 代码库关系：直接驱动同目录的 `gateway-credentials.ts`，使用临时配置根目录
 * 模拟 `server.ts` 的启动与首次配置流程，不触碰真实 `.data`。
 * 输入输出与副作用：测试会在临时目录中写入受保护凭据文件，完成后删除；Token
 * 只作为内存返回值和校验输入存在，持久化内容必须是不可逆校验数据。
 */
import { readFile, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  issuePersistentGatewayToken,
  loadPersistentGatewayCredential,
  verifyPersistentGatewayToken,
} from "./gateway-credentials.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("persistent gateway credentials", () => {
  it("persists only a verifier and verifies the issued token", async () => {
    const root = await mkdtemp(join(tmpdir(), "kaguya-gateway-credentials-"));
    roots.push(root);

    const token = await issuePersistentGatewayToken(root);
    const credentialPath = join(root, "gateway-credential.json");
    const persisted = await readFile(credentialPath, "utf8");

    expect(token).toMatch(/^[A-Za-z0-9_-]{32,}$/u);
    expect(persisted).not.toContain(token);
    expect(await loadPersistentGatewayCredential(root)).not.toBeNull();
    expect(
      await verifyPersistentGatewayToken(root, token),
    ).toBe(true);
    expect(
      await verifyPersistentGatewayToken(root, "wrong-token"),
    ).toBe(false);
  });
});
