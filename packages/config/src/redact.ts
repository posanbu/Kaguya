export const REDACTED_CONFIG_VALUE = "[REDACTED]";

const secretTerms = [
  "apikey",
  "token",
  "secret",
  "password",
  "credential",
  "privatekey",
  "accesskey",
];

export function redactConfigValue<T>(value: T): T {
  return redact(value) as T;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        isSecretKey(key) ? REDACTED_CONFIG_VALUE : redact(entry),
      ]),
    );
  }
  return value;
}

function isSecretKey(key: string): boolean {
  const normalized = key.replaceAll(/[^a-z0-9]/gi, "").toLowerCase();
  return secretTerms.some((term) => normalized.includes(term));
}
