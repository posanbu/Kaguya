import { z } from "@kaguya/schema";
import { GATEWAY_UNAUTHORIZED_EVENT } from "./api.js";

const viewSchema = z.strictObject({
  templateId: z.enum([
    "memory.identity.name",
    "memory.identity.aliases",
    "memory.identity.persona",
  ]),
  displayName: z.string(),
  description: z.string(),
  allowedVariables: z.array(z.string()),
  content: z.string(),
  defaultContent: z.string(),
  source: z.enum(["default", "local"]),
  effect: z.literal("restart_required"),
  revision: z.string(),
});
export type IdentityPersonaTemplateView = z.infer<typeof viewSchema>;
export type IdentityResourceKind = "name" | "aliases" | "persona";

export async function requestIdentityPersonaTemplate(
  token: string,
  kind: IdentityResourceKind = "persona",
  change?: { revision: string; content?: string; restore?: boolean },
): Promise<IdentityPersonaTemplateView> {
  const response = await fetch(`/api/v1/identity/${kind}-template`, {
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
  });
  if (response.status === 401)
    window.dispatchEvent(new Event(GATEWAY_UNAUTHORIZED_EVENT));
  const body = await response.json();
  if (!response.ok)
    throw new Error(
      body.error?.code === "templates_changed"
        ? "身份模板已被其他操作修改；草稿已保留，请重新读取。"
        : "身份模板操作失败，请检查内容或管理认证。",
    );
  return viewSchema.parse(body.data);
}
