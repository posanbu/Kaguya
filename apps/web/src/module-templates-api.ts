/**
 * 功能概述：模板管理客户端，校验静态源码 DTO 并将稳定错误码翻译为编辑提示。
 * 主要职责：requestModuleTemplates 读取、保存或恢复；401 通知统一锁屏，冲突保持草稿。
 * 代码库关系：ModuleTemplatesSection 使用本客户端；不读取运行时 Prompt 或发送预览请求。
 * 输入输出与副作用：仅同源认证请求，不保存 Token，不返回底层解析错误正文。
 */
import { moduleTemplatesViewSchema } from "@kaguya/schema";
import { GATEWAY_UNAUTHORIZED_EVENT } from "./api.js";
const messages: Record<string, string> = {
  template_too_large: "模板超过 128 KiB UTF-8 上限，请缩短源码。",
  empty_template: "模板不能为空或仅包含空白。",
  unknown_variable: "存在未知变量或不允许的路径。请使用本模板列出的变量。",
  invalid_partial: "存在未知或动态 partial。请使用列出的静态 partial 名称。",
  recursive_partial: "模板存在循环依赖。请移除形成循环的 partial 引用。",
  unsupported_helper:
    "helper 不受支持。仅允许 each、if、unless 块，不允许子表达式。",
  invalid_syntax: "Handlebars 语法无效，请检查花括号与块的开闭。",
  templates_changed:
    "模板组已被其他操作修改。当前输入已保留，请重新读取后再编辑。",
  invalid_template_input: "模板输入格式无效或长度超限。",
};
export async function requestModuleTemplates(
  token: string,
  definitionId: string,
  change?: {
    templateId: string;
    revision: string;
    content?: string;
    restore?: boolean;
  },
  signal?: AbortSignal,
) {
  if (!token.trim()) throw new Error("请先填写管理 Token。");
  const url = `/api/v1/modules/${encodeURIComponent(definitionId)}/templates`;
  const response = await fetch(
    change ? `${url}/${encodeURIComponent(change.templateId)}` : url,
    {
      method: change ? (change.restore ? "DELETE" : "PUT") : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(change
        ? {
            body: JSON.stringify({
              revision: change.revision,
              ...(change.restore ? {} : { content: change.content }),
            }),
          }
        : {}),
      ...(signal ? { signal } : {}),
    },
  );
  if (response.status === 401)
    window.dispatchEvent(new Event(GATEWAY_UNAUTHORIZED_EVENT));
  const body = await response.json();
  if (!response.ok)
    throw new Error(
      messages[body.error?.code] ??
        "模板操作失败，请检查管理认证或服务器状态。当前输入已保留。",
    );
  return moduleTemplatesViewSchema.parse(body.data);
}
