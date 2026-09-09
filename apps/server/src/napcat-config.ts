/**
 * 功能概述：负责 selected Profile 内 NapCat 平台条目的校验和脱敏投影。
 * 主要职责：校验 WebSocket 地址与重连间隔、构造启动配置，并检测已退役的
 * `napcat.json`，要求用户显式迁移而不是静默采用第二份配置真值。
 * 代码库关系：`setup.ts` 负责 Profile 读写，`config.ts` 从同一 selected Profile
 * 生成启动配置；本模块只保留值对象转换和遗留文件门禁。
 * 输入输出与副作用：除检查遗留文件是否存在外不读写磁盘；公开状态不泄漏 token，
 * 所有迁移与校验错误均不包含旧文件内容。
 */
import { access } from "node:fs/promises";
import { join } from "node:path";

import { ConfigError } from "@kaguya/config";

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

export async function assertNoLegacyNapCatSettings(
  rootDir: string,
): Promise<void> {
  try {
    await access(join(rootDir, "napcat.json"));
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  throw new ConfigError(
    "CONFIG_UNSUPPORTED_VERSION",
    "Legacy napcat.json is not supported; move NapCat settings into the selected Profile",
  );
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

export function validateNapCatSettings(value: unknown): NapCatSettings {
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

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
