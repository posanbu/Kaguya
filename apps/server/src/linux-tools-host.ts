/**
 * 合并 GUI 的显式模型路由与归档读取器；模型定义仍由 selected Profile 的 composition 批准。
 * 功能概述：从敏感 linux-tools.json 显式加载 Linux 工具，随 Server 的 MCP/Runtime 生命周期组合。
 * openLinuxTools 缺省关闭、不创建配置或环境；每个 scope 仅绑定管理员预先建立的环境。
 * mergeLinuxTools 合并 registrations/task 路由/providers 并注入 W6 hooks；不覆盖 MCP 或 Memory。
 * 代码库关系：mcp-host.ts 打开及关闭此宿主，Runtime 通过工具 bind 延迟取得私有 lease。
 */
import { join } from "node:path";
import { lstat } from "node:fs/promises";
import { readSensitiveJson } from "@kaguya/config";
import {
  LinuxToolsHost,
  linuxToolsConfigurationSchema,
  type NativeToolLoopOptions,
  type ActionExecutorOptions,
} from "@kaguya/runtime";
import type { ActionProvider } from "@kaguya/sdk";

export async function openLinuxTools(root: string) {
  try {
    await lstat(join(root, "linux-tools.json"));
    return new LinuxToolsHost(
      linuxToolsConfigurationSchema.parse(
        await readSensitiveJson(join(root, "linux-tools.json")),
      ),
    );
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return undefined;
    throw new Error("linux-tools-configuration-invalid");
  }
}
export function mergeLinuxTools<
  T extends {
    nativeTools?: NativeToolLoopOptions;
    actionProviders?: readonly ActionProvider[];
  },
>(
  host: LinuxToolsHost | undefined,
  composition: T,
): Omit<T, "nativeTools" | "actionProviders"> & {
  nativeTools?: NativeToolLoopOptions;
  actionProviders?: readonly ActionProvider[];
  actionEnvironment?: Pick<
    ActionExecutorOptions,
    "resolveLeaseCredential" | "validateEnvironment"
  >;
} {
  if (!host) return composition;
  const linux = host.snapshot();
  if (!linux.nativeTools.registrations.length) return composition;
  const tasks = new Map<string, NativeToolLoopOptions["tasks"][number]>();
  for (const task of [
    ...(composition.nativeTools?.tasks ?? []),
    ...linux.nativeTools.tasks,
  ]) {
    const key = JSON.stringify([task.definitionId, task.taskId, task.routeId]);
    tasks.set(key, {
      ...task,
      toolIds: [
        ...new Set([...(tasks.get(key)?.toolIds ?? []), ...task.toolIds]),
      ],
    });
  }
  return {
    ...composition,
    actionProviders: [
      ...(composition.actionProviders ?? []),
      ...linux.actionProviders,
    ],
    actionEnvironment: linux.actionEnvironment,
    nativeTools: {
      ...composition.nativeTools,
      readArtifact: linux.nativeTools.readArtifact,
      guiTasks: linux.nativeTools.guiTasks,
      registrations: [
        ...(composition.nativeTools?.registrations ?? []),
        ...linux.nativeTools.registrations,
      ],
      tasks: [...tasks.values()],
    },
  };
}
