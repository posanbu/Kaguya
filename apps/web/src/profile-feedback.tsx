/**
 * 功能概述：配置字段的本地校验、服务端路径映射及可访问的就近反馈。
 * 主要职责：validateProfileFields 校验可确定约束；mapProfileProblem 只定位当前可编辑 provider；
 * ProfileField 给既有控件添加稳定 ID/blur/aria 关联；摘要聚合并聚焦首个可定位问题。
 * 代码库关系：App 提供所属 Profile 的问题和 touched 状态，不用 selected 的检查替代编辑对象；
 * 不改变 profile-editor 的完整替换和隐藏字段保全契约。
 * 输入输出与副作用：校验不请求网络；聚焦仅操作当前页面控件；错误不回显秘密值。
 */
import {
  cloneElement,
  createContext,
  useContext,
  type ReactElement,
  type ReactNode,
  type FocusEventHandler,
} from "react";
import { FieldMessage, Button } from "./components/ui.js";
import type { ProfileEditorFields } from "./profile-editor.js";
import type { UserConfigProfile } from "./api.js";
export type Field = keyof ProfileEditorFields;
export type Section =
  "profile" | "identity" | "models" | "allowlist" | "memory";
export interface ProfileProblem {
  field?: Field;
  section: Section;
  message: string;
  warning?: boolean;
}
export function fieldSection(field: Field): Section {
  if (field === "name") return "profile";
  if (field.startsWith("agent")) return "identity";
  if (field.endsWith("AllowlistText")) return "allowlist";
  return "models";
}
export function validateProfileFields(
  fields: ProfileEditorFields,
): ProfileProblem[] {
  const issues: ProfileProblem[] = [];
  const add = (field: Field, message: string, warning = false) =>
    issues.push({ field, section: fieldSection(field), message, warning });
  if (!fields.name.trim() || fields.name.trim().length > 100)
    add("name", "Profile 名称需为 1–100 个字符。");
  if (!isIanaTimeZone(fields.agentTimeZone.trim()))
    add("agentTimeZone", "请输入有效的 IANA 时区，例如 Asia/Shanghai。");
  try {
    new URL(fields.baseUrl);
  } catch {
    add("baseUrl", "请输入完整的模型服务 URL。");
  }
  if (!fields.apiKey.trim())
    add("apiKey", "尚未填写 API Key；启用的 Provider 可能无法调用。", true);
  for (const tier of ["light", "heavy"] as const) {
    if (!fields[`${tier}Model`].trim()) add(`${tier}Model`, "请输入模型 ID。");
    const timeout = fields[`${tier}TimeoutSeconds`].trim();
    if (
      timeout &&
      (!/^(?:\d+(?:\.\d{1,3})?|\.\d{1,3})$/u.test(timeout) ||
        Number(timeout) < 0.001 ||
        Number(timeout) > 300)
    )
      add(`${tier}TimeoutSeconds`, "超时需在 0.001–300 秒之间，最多三位小数。");
    const duration = fields[`${tier}RecommendedDurationMs`].trim();
    if (
      duration &&
      (!Number.isSafeInteger(Number(duration)) ||
        Number(duration) < 1 ||
        Number(duration) > 300000)
    )
      add(
        `${tier}RecommendedDurationMs`,
        "推荐响应时间需为 1–300000 的整数毫秒。",
      );
  }
  return issues;
}
export function mapProfileProblem(
  problem: { path: string; message: string },
  profile: UserConfigProfile,
  warning = false,
): ProfileProblem {
  const paths: Record<string, Field> = {
    name: "name",
    "identity.timeZone": "agentTimeZone",
    inboundAllowlist: "inboundAllowlistText",
    outboundAllowlist: "outboundAllowlistText",
  };
  let field = paths[problem.path];
  const preferred = profile.ai.providers.findIndex(
    (provider) =>
      provider.id === profile.ai.defaultProviderId &&
      provider.type === "openai-compatible",
  );
  const providerIndex =
    preferred >= 0
      ? preferred
      : profile.ai.providers.findIndex(
          (provider) => provider.type === "openai-compatible",
        );
  const editableIndex =
    providerIndex >= 0 ? providerIndex : profile.ai.providers.length;
  if (problem.path === `ai.providers.${editableIndex}.baseUrl`)
    field = "baseUrl";
  if (problem.path === `ai.providers.${editableIndex}.apiKey`) field = "apiKey";
  for (const tier of ["light", "heavy"] as const) {
    if (problem.path === `ai.modelTiers.${tier}.modelId`)
      field = `${tier}Model`;
    if (problem.path === `ai.modelTiers.${tier}.generation.timeoutMs`)
      field = `${tier}TimeoutSeconds`;
    if (problem.path === `ai.modelTiers.${tier}.recommendedDurationMs`)
      field = `${tier}RecommendedDurationMs`;
    if (problem.path === `ai.modelTiers.${tier}.generation.reasoning`)
      field = `${tier}ReasoningEffort`;
  }
  const section = field
    ? fieldSection(field)
    : problem.path.startsWith("ai")
      ? "models"
      : problem.path.startsWith("identity")
        ? "identity"
        : problem.path.startsWith("memory")
          ? "memory"
          : /Allowlist/u.test(problem.path)
            ? "allowlist"
            : "profile";
  return {
    ...(field ? { field } : {}),
    section,
    message: problem.message,
    warning,
  };
}

function isIanaTimeZone(value: string): boolean {
  if (!value) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}
const Feedback = createContext<{
  issues: readonly ProfileProblem[];
  touch: (field: Field) => void;
}>({ issues: [], touch: () => {} });
export const ProfileFeedback = Feedback.Provider;
interface ControlProps {
  id?: string;
  onBlur?: FocusEventHandler<HTMLElement>;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}
export function ProfileField({
  name,
  children,
}: {
  name: Field;
  children: ReactElement<ControlProps>;
}) {
  const { issues, touch } = useContext(Feedback);
  const messages = issues.filter((issue) => issue.field === name);
  const id = `profile-field-${name}`;
  return (
    <>
      {cloneElement(children, {
        id,
        onBlur: (event) => {
          children.props.onBlur?.(event);
          touch(name);
        },
        "aria-invalid": messages.some((issue) => !issue.warning),
        "aria-describedby": [
          children.props["aria-describedby"],
          ...(messages.length ? [`${id}-error`] : []),
        ]
          .filter(Boolean)
          .join(" "),
      })}
      {messages.length > 0 && (
        <span id={`${id}-error`} className="profile-field-errors">
          {messages.map((issue, index) => (
            <FieldMessage
              key={index}
              tone={issue.warning ? "neutral" : "error"}
            >
              {issue.message}
            </FieldMessage>
          ))}
        </span>
      )}
    </>
  );
}
export function ProfileSectionIssues({ section }: { section: Section }) {
  const { issues } = useContext(Feedback);
  return (
    <>
      {issues
        .filter((issue) => !issue.field && issue.section === section)
        .map((issue, index) => (
          <FieldMessage key={index} tone={issue.warning ? "neutral" : "error"}>
            {issue.message}
          </FieldMessage>
        ))}
    </>
  );
}
export function ProfileProblemSummary({
  name,
  children,
}: {
  name: string;
  children?: ReactNode;
}) {
  const { issues } = useContext(Feedback);
  if (issues.length === 0) return null;
  const focusable = issues.find((issue) => issue.field);
  return (
    <section
      className="profile-problem-summary"
      aria-label="当前 Profile 问题摘要"
    >
      <h3>{name} · 配置检查</h3>
      <p>
        {issues.filter((issue) => !issue.warning).length} 个错误，
        {issues.filter((issue) => issue.warning).length} 个警告
      </p>
      {issues.length > 0 && (
        <ul>
          {issues.map((issue, index) => (
            <li key={index}>{issue.message}</li>
          ))}
        </ul>
      )}
      {focusable?.field && (
        <Button
          onClick={() =>
            document.getElementById(`profile-field-${focusable.field}`)?.focus()
          }
        >
          定位首个问题
        </Button>
      )}
      {children}
    </section>
  );
}
