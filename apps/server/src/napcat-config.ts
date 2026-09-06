/**
 * 功能概述：负责 NapCat WebUI 配置的文件持久化、校验和脱敏投影，补上环境变量配置之外的运行时管理入口。
 * 主要职责：`loadNapCatSettings` 在缺少文件时返回安全默认值；`saveNapCatSettings` 校验 WebSocket 地址与重连间隔后以原子方式写入；`toNapCatStatus` 只返回 UI 所需状态，不泄漏 access token。
 * 代码库关系：配置文件位于 `KAGUYA_CONFIG_ROOT/napcat.json`，由 `setup.ts` 的 HTTP 管理门面调用，并由 `server.ts` 在创建 Runtime/NapCat supervisor 前读取；类型与启动参数对应 `config.ts` 的 NapCatConfig。
 * 输入输出与副作用：读写操作只作用于配置根目录；access token 仅写入受保护文件，公开状态以 `hasAccessToken` 表示；启用配置缺少 URL 或参数越界时抛出无 secret 的校验错误。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { NapCatConfig } from "./config.js";

export interface NapCatSettings {
  readonly enabled: boolean;
  readonly wsUrl?: string;
  readonly accessToken?: string;
  readonly selfId?: string;
  readonly reconnectMs: number;
}

export interface NapCatStatus {
  readonly enabled: boolean;
  readonly wsUrl?: string;
  readonly hasAccessToken: boolean;
  readonly selfId?: string;
  readonly reconnectMs: number;
}

export const defaultNapCatSettings: NapCatSettings = Object.freeze({
  enabled: false,
  reconnectMs: 3000,
});

export async function loadNapCatSettings(
  rootDir: string,
): Promise<NapCatSettings> {
  try {
    return validateNapCatSettings(
      JSON.parse(await readFile(settingsPath(rootDir), "utf8")) as unknown,
    );
  } catch (error) {
    if (isMissingFile(error)) return defaultNapCatSettings;
    throw error;
  }
}

export async function hasNapCatSettings(rootDir: string): Promise<boolean> {
  try {
    await readFile(settingsPath(rootDir));
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

export async function saveNapCatSettings(
  rootDir: string,
  input: NapCatSettings,
): Promise<NapCatSettings> {
  const settings = validateNapCatSettings(input);
  await mkdir(rootDir, { recursive: true, mode: 0o700 });
  const path = settingsPath(rootDir);
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
  return settings;
}

export function toNapCatStatus(settings: NapCatSettings): NapCatStatus {
  return {
    enabled: settings.enabled,
    ...(settings.wsUrl === undefined ? {} : { wsUrl: settings.wsUrl }),
    hasAccessToken: settings.accessToken !== undefined,
    ...(settings.selfId === undefined ? {} : { selfId: settings.selfId }),
    reconnectMs: settings.reconnectMs,
  };
}

export function toNapCatConfig(settings: NapCatSettings): NapCatConfig {
  if (settings.enabled && settings.wsUrl === undefined) {
    throw new Error("KAGUYA_NAPCAT_WS_URL is required when NapCat is enabled");
  }
  return {
    enabled: settings.enabled,
    adapterId: "napcat.qq.main",
    ...(settings.wsUrl === undefined ? {} : { wsUrl: settings.wsUrl }),
    ...(settings.accessToken === undefined
      ? {}
      : { accessToken: settings.accessToken }),
    ...(settings.selfId === undefined ? {} : { selfId: settings.selfId }),
    reconnectMs: settings.reconnectMs,
  };
}

function validateNapCatSettings(value: unknown): NapCatSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("NapCat configuration must be an object");
  }
  const record = value as Record<string, unknown>;
  const enabled = record.enabled;
  const wsUrl = optionalString(record.wsUrl);
  const accessToken = optionalString(record.accessToken);
  const selfId = optionalString(record.selfId);
  const reconnectMs = record.reconnectMs;
  if (typeof enabled !== "boolean")
    throw new Error("NapCat enabled must be a boolean");
  if (enabled && wsUrl === undefined)
    throw new Error("WebSocket URL is required when NapCat is enabled");
  if (
    typeof reconnectMs !== "number" ||
    !Number.isInteger(reconnectMs) ||
    reconnectMs < 100 ||
    reconnectMs > 3_600_000
  ) {
    throw new Error(
      "Reconnect interval must be an integer between 100 and 3600000",
    );
  }
  if (wsUrl !== undefined && !/^wss?:\/\//u.test(wsUrl)) {
    throw new Error("WebSocket URL must start with ws:// or wss://");
  }
  return {
    enabled,
    ...(wsUrl === undefined ? {} : { wsUrl }),
    ...(accessToken === undefined ? {} : { accessToken }),
    ...(selfId === undefined ? {} : { selfId }),
    reconnectMs,
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function settingsPath(rootDir: string): string {
  return join(rootDir, "napcat.json");
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
