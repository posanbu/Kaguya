/**
 * 功能概述：负责 Gateway 正式凭据的生成、持久化与校验，是 Server 启动认证层
 * 与首次配置流程之间的敏感配置边界。
 * 主要职责：`issuePersistentGatewayToken` 生成高熵正式 Token 并只写入带 salt 的
 * 不可逆 scrypt 校验值；`loadPersistentGatewayCredential` 读取并校验凭据文件；
 * `verifyPersistentGatewayToken` 使用恒定时间比较判断请求 Token 是否匹配。
 * 代码库关系：凭据文件位于 `KAGUYA_CONFIG_ROOT/gateway-credential.json`，依赖
 * `@kaguya/config` 的敏感 JSON 原子写入与读取工具，由 `server.ts` 的启动认证
 * 编排和 `app.ts` 的请求认证调用；本模块不参与 Profile 或 Core Session 语义。
 * 输入输出与副作用：Token 明文只作为生成结果返回或校验输入存在，磁盘只保存
 * 版本、salt 与校验值；缺失文件返回 `null`，格式损坏或 IO 错误沿用配置错误。
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { join } from "node:path";

import {
  ConfigError,
  readSensitiveJson,
  writeSensitiveJson,
} from "@kaguya/config";

const scrypt = promisify(scryptCallback);
const CREDENTIAL_VERSION = 1;
const TOKEN_BYTES = 32;
const SALT_BYTES = 16;
const KEY_BYTES = 64;

interface PersistedGatewayCredential {
  readonly version: 1;
  readonly salt: string;
  readonly verifier: string;
}

export async function issuePersistentGatewayToken(
  rootDir: string,
): Promise<string> {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const salt = randomBytes(SALT_BYTES);
  const verifier = await deriveVerifier(token, salt);
  await writeSensitiveJson(credentialPath(rootDir), {
    version: CREDENTIAL_VERSION,
    salt: salt.toString("base64url"),
    verifier: verifier.toString("base64url"),
  } satisfies PersistedGatewayCredential);
  return token;
}

export async function loadPersistentGatewayCredential(
  rootDir: string,
): Promise<PersistedGatewayCredential | null> {
  try {
    const value = await readSensitiveJson(credentialPath(rootDir));
    if (!isPersistedGatewayCredential(value)) {
      throw new Error("Invalid gateway credential format");
    }
    return value;
  } catch (error) {
    if (isMissingError(error)) {
      return null;
    }
    throw error;
  }
}

export async function verifyPersistentGatewayToken(
  rootDir: string,
  token: string,
): Promise<boolean> {
  const credential = await loadPersistentGatewayCredential(rootDir);
  if (credential === null) {
    return false;
  }
  const expected = Buffer.from(credential.verifier, "base64url");
  const actual = await deriveVerifier(
    token,
    Buffer.from(credential.salt, "base64url"),
  );
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function deriveVerifier(token: string, salt: Buffer): Promise<Buffer> {
  return Buffer.from(
    (await scrypt(token, salt, KEY_BYTES)) as Uint8Array,
  );
}

function credentialPath(rootDir: string): string {
  return join(rootDir, "gateway-credential.json");
}

function isPersistedGatewayCredential(
  value: unknown,
): value is PersistedGatewayCredential {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === CREDENTIAL_VERSION &&
    typeof candidate.salt === "string" &&
    typeof candidate.verifier === "string"
  );
}

function isMissingError(error: unknown): boolean {
  if (error instanceof ConfigError) {
    return isMissingError(error.cause);
  }
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
