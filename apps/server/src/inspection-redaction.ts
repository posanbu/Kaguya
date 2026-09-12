/**
 * 功能概述：开发者 Inspection 所有 JSON 响应共用的秘密脱敏边界，覆盖嵌入 Prompt 的凭据。
 * 主要职责：createInspectionRedactor 从宿主配置收集敏感字段值及 URL 密码；返回的纯函数
 * 递归清理敏感字段、已知秘密（含 URL 编码）和文本中的 Bearer、密钥赋值、私钥与 URL 认证。
 * 代码库关系：server.ts 只在闭包中传入启动配置，inspection.ts 在 DTO 输出前调用；配置不进入 DTO。
 * 输入输出与副作用：接受 JSON 可序列化投影，返回独立 JSON，无日志、网络或原对象修改。
 */
import type { JsonValue } from "@kaguya/schema";
const hidden = "[REDACTED]";
const sensitive =
  /^(?:.*(?:apikey|accesstoken|refreshtoken|gatewaytoken|password|passwd|secret|credential|privatekey|accesskey).*|token|authorization|cookie|setcookie)$/i;
const isSecret = (key: string) =>
  sensitive.test(key.replace(/[^a-z0-9]/gi, ""));

export function createInspectionRedactor(configuration: unknown) {
  const secrets = new Set<string>();
  function collect(value: unknown, secret = false): void {
    if (typeof value === "string") {
      if (secret && value) {
        secrets.add(value);
        try {
          secrets.add(encodeURIComponent(value));
        } catch {
          /* 无效 Unicode 仍按原值清理。 */
        }
      }
      for (const match of value.matchAll(
        /[a-z][a-z0-9+.-]*:\/\/([^\s/@]+)@/gi,
      )) {
        secrets.add(match[1]!);
        const password = match[1]!.split(":").slice(1).join(":");
        if (password) {
          secrets.add(password);
          try {
            secrets.add(decodeURIComponent(password));
          } catch {
            /* 非标准 URL 仍清理原值。 */
          }
        }
      }
    } else if (Array.isArray(value)) value.forEach((v) => collect(v, secret));
    else if (value && typeof value === "object")
      Object.entries(value).forEach(([key, v]) =>
        collect(v, secret || isSecret(key)),
      );
  }
  collect(configuration);
  const ordered = [...secrets]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const cleanText = (text: string) => {
    let result = text;
    for (const secret of ordered) result = result.split(secret).join(hidden);
    return result
      .replace(
        /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
        hidden,
      )
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${hidden}@`)
      .replace(/\b(Bearer|Basic)\s+[^\s"'<>]+/gi, `$1 ${hidden}`)
      .replace(
        /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g,
        hidden,
      )
      .replace(
        /((?:api[_-]?key|(?:access[_-]?|refresh[_-]?|gateway[_-]?)?token|secret|password|authorization|cookie)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s&,;}]+)/gi,
        `$1${hidden}`,
      );
  };
  function redact(value: unknown): JsonValue {
    if (typeof value === "string") return cleanText(value);
    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "number"
    )
      return value;
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, v]) => v !== undefined)
          .map(([key, v]) => [
            cleanText(key),
            isSecret(key) ? hidden : redact(v),
          ]),
      );
    return null;
  }
  return redact;
}
