/**
 * 功能概述：将 Profile 请求校验错误投影为不含输入值的字段定位信息。
 * 主要职责：profileFieldErrors 接受 Zod 或 Fastify/AJV 错误，只允许已知配置路径，
 * 限制条数并使用固定中文说明；未知键、原始错误 message 和实际凭据不会回传。
 * 代码库关系：app.ts 仅在认证后的 Profile 请求校验失败时使用；Web 映射到可编辑字段。
 * 输入输出与副作用：只读未知错误对象，返回 path/message；不记录或持久化请求正文。
 */
const safePath =
  /^(?:name|identity(?:\.(?:name|aliases(?:\.\d+)?|persona|timeZone))?|(?:inbound|outbound)Allowlist(?:\.\d+)?|ai(?:\.(?:defaultProviderId|providers(?:\.\d+(?:\.(?:id|type|enabled|baseUrl|apiKey|models(?:\.\d+)?))?)?|modelTiers(?:\.(?:light|heavy)(?:\.(?:providerId|modelId|recommendedDurationMs|generation(?:\.(?:timeoutMs|reasoning))?))?)?))?|memory(?:\.(?:enabled|embedding|cognition))?|platforms(?:\.\d+)?|acknowledgedWarnings(?:\.\d+)?)$/u;
export function profileFieldErrors(
  error: unknown,
): { path: string; message: string }[] {
  if (!error || typeof error !== "object") return [];
  const source =
    "issues" in error
      ? error.issues
      : "validation" in error
        ? error.validation
        : [];
  if (!Array.isArray(source)) return [];
  return [
    ...new Set(
      source.slice(0, 40).map((issue: unknown) => {
        if (!issue || typeof issue !== "object") return "";
        let path =
          "path" in issue && Array.isArray(issue.path)
            ? issue.path.join(".")
            : "instancePath" in issue && typeof issue.instancePath === "string"
              ? issue.instancePath.replace(/^\//u, "").replaceAll("/", ".")
              : "";
        if (
          "params" in issue &&
          issue.params &&
          typeof issue.params === "object" &&
          "missingProperty" in issue.params &&
          typeof issue.params.missingProperty === "string"
        )
          path = [path, issue.params.missingProperty].filter(Boolean).join(".");
        return safePath.test(path) ? path : "";
      }),
    ),
  ].map((path) => ({
    path,
    message: path
      ? "字段值不符合配置约束，请检查格式、范围或关联项。"
      : "配置包含无法定位的无效字段，请检查配置结构。",
  }));
}
