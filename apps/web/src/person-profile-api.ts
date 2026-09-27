import {
  personProfileViewSchema,
  type ManualPersonProfileSections,
  type PersonProfileMetadata,
  type PersonProfileView,
} from "@kaguya/schema";
import { GATEWAY_UNAUTHORIZED_EVENT } from "./api.js";

async function request(
  token: string,
  personInformationId: string,
  suffix = "",
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
) {
  const response = await fetch(
    `/api/v1/people/${encodeURIComponent(personInformationId)}/profile${suffix}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    },
  );
  if (response.status === 401)
    window.dispatchEvent(new Event(GATEWAY_UNAUTHORIZED_EVENT));
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      result.error?.code === "profile_changed"
        ? "人物资料已被其他操作修改。请先复制当前草稿，再刷新页面合并。"
        : result.error?.code === "person_not_found"
          ? "人物身份已不可用，请重新选择人物。"
          : "人物资料操作失败，请检查内容或管理认证。",
    );
  return result.data;
}

export async function getPersonProfile(
  token: string,
  personInformationId: string,
  signal?: AbortSignal,
): Promise<PersonProfileView> {
  return personProfileViewSchema.parse(
    await request(token, personInformationId, "", "GET", undefined, signal),
  );
}

export async function savePersonProfile(
  token: string,
  personInformationId: string,
  revision: number,
  sections: ManualPersonProfileSections,
  metadata: PersonProfileMetadata,
): Promise<PersonProfileView> {
  return personProfileViewSchema.parse(
    await request(token, personInformationId, "", "PUT", {
      revision,
      sections,
      metadata,
    }),
  );
}

export async function previewPersonProfile(
  token: string,
  personInformationId: string,
  sections: ManualPersonProfileSections,
  metadata: PersonProfileMetadata,
  signal?: AbortSignal,
): Promise<{ preview: string; previewName: string }> {
  const value = await request(
    token,
    personInformationId,
    "/preview",
    "POST",
    { sections, metadata },
    signal,
  );
  if (
    typeof value?.preview !== "string" ||
    typeof value?.previewName !== "string"
  )
    throw new Error("人物资料预览格式无效。");
  return value;
}
