/**
 * 功能概述：验证统一 Inspection 脱敏器覆盖嵌套 JSON、已知秘密和自由文本中的凭据。
 * 主要职责：检查 URL 编码、私钥、Bearer、未知敏感字段，确保完整正常 Prompt 与 token 计数保留。
 * 代码库关系：直接调用 inspection-redaction.ts，不依赖网络或数据库。
 * 输入输出与副作用：内存断言，同时验证源对象不变，脱敏不截断正常内容。
 */
import { expect, it } from "vitest";
import { createInspectionRedactor } from "./inspection-redaction.js";
it("cleans secrets recursively including compiled prompts without dropping normal content", () => {
  const redact = createInspectionRedactor({
    apiKey: "a/key+secret",
    databaseUrl: "postgresql://user:db-password@host/db",
    nested: { credentials: { value: "custom-credential" } },
  });
  const source = {
    prompt: {
      text: "keep me a/key+secret a%2Fkey%2Bsecret db-password custom-credential Bearer header-secret Basic dXNlcjpwYXNzd29yZA==",
      templates: [
        {
          content:
            "Authorization: Bearer other-secret\napi_key=unknown-key\ntoken=unknown-token",
        },
      ],
    },
    tokenCount: 123,
    credentials: { anything: "private" },
    cookie: "secret-cookie",
    url: "https://someone:url-password@host/path?access_token=inline-secret",
    key: "-----BEGIN PRIVATE KEY-----\nkey bytes\n-----END PRIVATE KEY-----",
  };
  const result = JSON.stringify(redact(source));
  for (const secret of [
    "a/key+secret",
    "a%2Fkey%2Bsecret",
    "db-password",
    "custom-credential",
    "header-secret",
    "dXNlcjpwYXNzd29yZA==",
    "other-secret",
    "unknown-key",
    "unknown-token",
    "private",
    "secret-cookie",
    "url-password",
    "inline-secret",
    "key bytes",
  ])
    expect(result).not.toContain(secret);
  expect(result).toContain("keep me");
  expect(result).toContain('"tokenCount":123');
  expect(source.credentials.anything).toBe("private");
});
