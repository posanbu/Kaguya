/**
 * 功能概述：定义平台无关的持久媒体字节能力，Information 只保存不可变摘要引用。
 * 主要职责：MediaResourceStore 提供幂等写入、完整性读取、删除及带保留谓词的过期清理；
 * mediaResourceStoreCapability 让受信模块使用同一文件/PostgreSQL 后端。
 * 代码库关系：Runtime 与输出插件持有该能力，媒体来源表另外核验 scene 与原始消息授权。
 * 输入输出与副作用：resourceId 是字节身份，不是读取授权；不得把此受信宿主接口直接暴露给模型或公共 API。
 * 清理谓词保护待投递/unknown 与历史来源；显式 delete 由调用方承担授权和保留检查。
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
