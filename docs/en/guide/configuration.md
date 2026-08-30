---
title: Configuration
description: A reusable structure for documenting Kaguya configuration.
outline: deep
---

# Configuration

Configuration documentation should describe where a value is defined, what it controls, its default, and whether changing it requires a restart.

## Suggested organization

### Runtime configuration

Document ports, log levels, storage locations, and network access here.

### Feature configuration

Keep settings grouped by feature instead of presenting one long unstructured list.

### Sensitive values

API tokens and passwords should be passed through environment variables or a local file excluded from Git.

::: danger Never commit secrets
Examples must use placeholder values. Do not place real tokens, passwords, or private endpoints in documentation or screenshots.
:::

## Example pattern

::: code-group

```dotenv [.env] icon="vscode-icons:file-type-dotenv"
KAGUYA_PORT=3000
KAGUYA_LOG_LEVEL=info
```

```typescript [Typed configuration] icon="logos:typescript-icon"
interface AppConfig {
  port: number
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}
```

:::

