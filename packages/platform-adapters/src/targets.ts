/**
 * 功能概述：定义 adapter 的只读可达会话目录，供宿主进行目标解析，不授予发送权限。
 * 主要职责：TargetDirectory 返回完整候选快照与账号/连接代次；targetKey 保留字符串 ID 和 adapter 身份。
 * 代码库关系：NapCat action client 获取目录，AdapterHost 检查在线状态，Runtime 授权服务消费候选。
 * 输入输出与副作用：本文件无 I/O；目录失败必须 reject，不能把部分响应当作完整目录。
 */
import type { PlatformDestination } from "@kaguya/schema";
export interface ReachableTarget {
  readonly adapterId: string;
  readonly platform: string;
  readonly destination: PlatformDestination;
  readonly name: string;
}
export interface TargetDirectorySnapshot {
  readonly generation: string;
  readonly candidates: readonly ReachableTarget[];
}
export interface TargetDirectory {
  listTargets(): Promise<TargetDirectorySnapshot>;
  /** 宿主在 transport 前同步拒绝查询之后的连接切换。 */
  isCurrentGeneration?(generation: string): boolean;
}
export function targetKey(
  target: Pick<ReachableTarget, "adapterId" | "platform" | "destination">,
): string {
  const d = target.destination;
  return JSON.stringify([
    target.adapterId,
    target.platform,
    d.kind,
    d.kind === "group" ? d.groupId : d.kind === "private" ? d.userId : d,
  ]);
}
