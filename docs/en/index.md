# Kaguya

Kaguya is an event-driven, pluggable TypeScript AI Bot Runtime. A single long-running Server process provides the Web UI, HTTP API, and optional platform connections while the shared Runtime handles messages, events, LLM calls, and outbound transports.

## Quick start

Requires Node.js 24.18.0 and pnpm 11.9.0.

```bash
corepack enable
pnpm install
export KAGUYA_GATEWAY_TOKEN="replace-with-at-least-16-characters"
export KAGUYA_CONFIG_ROOT="/absolute/path/to/kaguya-config"
pnpm dev
```

Open `http://127.0.0.1:3000`. For production, run `pnpm build` first and then `pnpm start`.

## Documentation

- [Architecture](./develop/)
- [Unified Server and HTTP API](./develop/message-server-and-adapters.md)
- [LLM Client](./develop/llm-providers.md)
- [Configuration and gateway allowlist](./manual/configuration/)
- [Web UI](./manual/webui/)
- [Structured logging](./develop/observability.md)
- [Remaining work](./faq/)

## Core boundaries

- The Runtime does not own sessions or partition history by private chat, group, or user fields.
- Inbound messages are persisted and published as events before modules filter, build context, and select an outbound target.
- Providers, models, and secrets are managed server-side and are never forwarded through the browser or public message API.
- NapCat is optional; disconnects do not stop HTTP or the Web UI.
