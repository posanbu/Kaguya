/**
 * 功能概述：验证 Gateway 认证器对 bootstrap、persistent 与 environment 凭据的
 * 来源优先级和授权范围隔离，保护 Issue #44 要求的最小权限边界。
 * 主要职责：确认 bootstrap 只能访问首次配置写入，不能访问消息或其他管理接口；
 * persistent/environment 凭据可以访问普通管理范围；首次配置成功后 bootstrap
 * 立即失效并返回一次正式 Token。
 * 代码库关系：直接驱动同目录 `gateway-auth.ts`，并通过其公开接口模拟 `app.ts`
 * 路由层的认证调用；持久化行为由 `gateway-credentials.ts` 负责。
 * 输入输出与副作用：测试使用临时配置根目录，可能写入 gateway credential 文件；
 * 不记录或断言任何日志内容，避免把敏感凭据写入测试输出。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createBootstrapGatewayAuthenticator,
  createEnvironmentGatewayAuthenticator,
  createPersistentGatewayAuthenticator,
  type GatewayScope,
} from "./gateway-auth.js";

const roots: string[] = [];
const scopes: GatewayScope[] = ["setup", "management", "messages"];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("gateway authentication", () => {
  it("limits bootstrap credentials to setup and rotates them after setup", async () => {
    const root = await mkdtemp(join(tmpdir(), "kaguya-gateway-auth-"));
    roots.push(root);
    const auth = await createBootstrapGatewayAuthenticator(root);

    const bootstrapToken = auth.bootstrapToken;
    expect(bootstrapToken).toMatch(/^[A-Za-z0-9_-]{32,}$/u);
    expect(await Promise.all(scopes.map((scope) => auth.authorize(bootstrapToken!, scope))))
      .toEqual([true, false, false]);

    const persistentToken = await auth.completeBootstrap();
    expect(await auth.authorize(bootstrapToken!, "setup")).toBe(false);
    expect(await auth.authorize(persistentToken, "management")).toBe(true);
    expect(await auth.authorize(persistentToken, "messages")).toBe(true);
  });

  it("accepts an environment token for all gateway scopes", async () => {
    const auth = createEnvironmentGatewayAuthenticator("environment-token");

    expect(await Promise.all(scopes.map((scope) => auth.authorize("environment-token", scope))))
      .toEqual([true, true, true]);
    expect(await auth.authorize("wrong-token", "setup")).toBe(false);
  });

  it("accepts a persisted token for all gateway scopes", async () => {
    const root = await mkdtemp(join(tmpdir(), "kaguya-gateway-auth-"));
    roots.push(root);
    const bootstrap = await createBootstrapGatewayAuthenticator(root);
    const token = await bootstrap.completeBootstrap();
    const auth = await createPersistentGatewayAuthenticator(root);

    expect(await Promise.all(scopes.map((scope) => auth.authorize(token, scope))))
      .toEqual([true, true, true]);
  });
});
