/**
 * 功能概述：将平台原生地址映射为持续 scene 身份，同时保留既有 Heartbeat/cognition 别名。
 * sceneIdentity 使用有序元组避免字符串分隔符碰撞，群聊不含发言者；私聊和 Web 保留目标隔离。
 * legacyHeartbeatScope 与 legacyCognitionScope 精确复现旧 key，供新消费进度读取既有账本。
 * 代码库关系：SDK 观察契约、数据库快照和第一方模块共同调用；仅依赖 schema 类型。
 * 输入输出与副作用：纯函数，不解析昵称、不合并身份、不执行 I/O；消费范围仍须校验完整地址。
 */
import type { PlatformDestination } from "./index.js";

export interface SceneAddress {
  readonly platform: string;
  readonly adapterId: string;
  readonly destination: PlatformDestination;
}

export function sceneIdentity(address: SceneAddress): string {
  const d = address.destination;
  const id =
    d.kind === "group"
      ? d.groupId
      : d.kind === "private"
        ? d.userId
        : (d.conversationId ?? null);
  return JSON.stringify([
    "scene.v1",
    address.platform,
    address.adapterId,
    d.kind,
    id,
  ]);
}

export function legacyHeartbeatScope(address: SceneAddress): string {
  const d = address.destination;
  const id =
    d.kind === "group"
      ? d.groupId
      : d.kind === "private"
        ? d.userId
        : (d.conversationId ?? "");
  return `${address.platform}:${address.adapterId}:${d.kind}:${id}`;
}

export function legacyCognitionScope(
  address: SceneAddress & { readonly senderId: string },
): string {
  return JSON.stringify([
    "scene.v2",
    address.platform,
    address.adapterId,
    address.destination.kind === "group" ? null : address.senderId,
    address.destination,
  ]);
}
