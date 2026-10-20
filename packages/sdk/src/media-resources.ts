/**
 * 平台无关的持久媒体资源能力。Information 只保存不可变资源引用；字节由宿主控制的存储读取。
 */
import { defineModuleCapability } from "./modules.js";

export interface MediaResourceInput {
  readonly resourceId: string;
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly sha256: string;
}

export interface MediaResource {
  readonly resourceId: string;
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly sha256: string;
}

export interface MediaResourceStore {
  put(input: MediaResourceInput): Promise<void>;
  get(resourceId: string): Promise<MediaResource | undefined>;
  delete(resourceId: string): Promise<void>;
  cleanupExpired(
    olderThan: Date,
    isRetained?: (resourceId: string) => Promise<boolean>,
  ): Promise<number>;
}

export const mediaResourceStoreCapability =
  defineModuleCapability<MediaResourceStore>("kaguya:media-resource-store", 1);
