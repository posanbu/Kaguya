/**
 * 功能概述：模块配置的独立认证客户端，避免耦合 Profile 编辑契约。
 * 主要职责：requestModuleSettings 校验安全响应并保留字段错误；401 通知工作台锁屏。
 * 代码库关系：ModuleSettingsSection 消费共享 schema；api.ts 仅提供统一认证失效事件名。
 * 输入输出与副作用：Token 仅发送至同源管理路由；不写本地存储，失败不清除编辑草稿。
 */
import {
  moduleSettingsViewSchema,
  type ModuleSettingsReplacement,
} from "@kaguya/schema";
import { GATEWAY_UNAUTHORIZED_EVENT } from "./api.js";
export class ModuleSettingsRequestError extends Error {
  constructor(
    message: string,
    readonly fields: readonly { path: string; message: string }[] = [],
  ) {
    super(message);
  }
}
export async function requestModuleSettings(
  token: string,
  definitionId: string,
  save?: { instanceId: string; replacement: ModuleSettingsReplacement },
  signal?: AbortSignal,
) {
  if (!token.trim())
    throw new ModuleSettingsRequestError("请先填写管理 Token。");
  const root = `/api/v1/modules/${encodeURIComponent(definitionId)}`;
  const response = await fetch(
    save
      ? `${root}/instances/${encodeURIComponent(save.instanceId)}/settings`
      : `${root}/settings`,
    {
      method: save ? "PUT" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(save ? { body: JSON.stringify(save.replacement) } : {}),
      ...(signal ? { signal } : {}),
    },
  );
  if (response.status === 401)
    window.dispatchEvent(new Event(GATEWAY_UNAUTHORIZED_EVENT));
  const body = await response.json();
  if (!response.ok)
    throw new ModuleSettingsRequestError(
      response.status === 409
        ? "配置已被其他操作修改。请保留当前输入并重新读取，再重新编辑。"
        : "操作失败，请检查字段、管理认证或服务器状态。",
      Array.isArray(body.error?.fields) ? body.error.fields : [],
    );
  return moduleSettingsViewSchema.parse(body.data);
}
