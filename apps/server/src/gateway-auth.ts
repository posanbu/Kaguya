/**
 * 功能概述：统一封装 Gateway Bearer 凭据的授权范围，隔离首次配置 bootstrap
 * Token 与正式 environment/persistent Token 的权限，避免路由各自实现认证规则。
 * 主要职责：`createBootstrapGatewayAuthenticator` 创建只存于内存的引导凭据，
 * `completeBootstrap` 原子地签发并持久化正式 Token；environment 与 persistent
 * 工厂分别构造显式环境凭据和配置根凭据的全范围认证器；`authorize` 返回请求
 * Token 是否拥有指定 setup、management 或 messages 权限。
 * 代码库关系：本模块由 `server.ts` 在启动时选择并传给 `app.ts`，持久化校验与
 * 写入委托给 `gateway-credentials.ts`；它不读取 Profile、不参与 Runtime 状态。
 * 输入输出与副作用：bootstrap Token 只存在于当前进程，首次完成后立即失效；
 * persistent 工厂读取敏感凭据文件，完成 bootstrap 会原子写入正式凭据，失败时
 * 不应让 bootstrap 自动获得管理或消息权限。
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

import {
  issuePersistentGatewayToken,
  verifyPersistentGatewayToken,
} from "./gateway-credentials.js";

export type GatewayScope = "setup" | "management" | "messages";

export interface GatewayAuthenticator {
  readonly bootstrapToken?: string;
  authorize(token: string, scope: GatewayScope): Promise<boolean>;
  completeBootstrap(): Promise<string>;
  distributeToken(): Promise<string | undefined>;
}

export async function createBootstrapGatewayAuthenticator(
  rootDir: string,
): Promise<GatewayAuthenticator> {
  const bootstrapToken = randomBytes(32).toString("base64url");
  let active = true;
  let persistentToken: string | undefined;
  let completion: Promise<string> | undefined;

  return {
    bootstrapToken,
    async authorize(token, scope) {
      if (!active && persistentToken !== undefined) {
        return safeEqual(token, persistentToken);
      }
      if (!active || scope !== "setup") {
        return false;
      }
      return safeEqual(token, bootstrapToken);
    },
    completeBootstrap() {
      if (!active) {
        return Promise.reject(new Error("Bootstrap gateway token is expired"));
      }
      completion ??= issuePersistentGatewayToken(rootDir).then((token) => {
        active = false;
        persistentToken = token;
        return token;
      });
      return completion;
    },
    async distributeToken() {
      return active ? bootstrapToken : persistentToken;
    },
  };
}

export function createEnvironmentGatewayAuthenticator(
  expectedToken: string,
): GatewayAuthenticator {
  return createStaticGatewayAuthenticator(expectedToken);
}

export function createPersistentGatewayAuthenticator(
  rootDir: string,
): GatewayAuthenticator {
  return {
    async authorize(token) {
      return verifyPersistentGatewayToken(rootDir, token);
    },
    completeBootstrap() {
      return Promise.reject(new Error("Bootstrap gateway token is unavailable"));
    },
    async distributeToken() {
      return undefined;
    },
  };
}

function createStaticGatewayAuthenticator(
  expectedToken: string,
): GatewayAuthenticator {
  return {
    async authorize(token) {
      return safeEqual(token, expectedToken);
    },
    completeBootstrap() {
      return Promise.reject(new Error("Bootstrap gateway token is unavailable"));
    },
    async distributeToken() {
      return expectedToken;
    },
  };
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
