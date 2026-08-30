---
title: WebUI HTTP API Entry
---

# WebUI HTTP API Entry

This section is now a compatibility note for the historical MaiBot WebUI API
docs that still live under `docs/en/develop/webui-api/*`.

The current Kaguya server does not expose the old FastAPI
`/api/webui/*`, `/api/config/*`, or `/api/chat/*` surfaces described by earlier
MaiBot materials. Its active management and runtime HTTP contract is the
Fastify-based `/api/v1/*` gateway documented elsewhere in this repository.

## Current Kaguya API surface

Use these routes for the live Kaguya control plane:

- `GET /api/v1/setup` returns secret-safe setup/readiness metadata:
  `status`, `selectedProfileId`, `profiles`, plus readiness `issues` and
  `warnings` when relevant.
- `GET /api/v1/profiles` returns profile metadata and the one global
  `selectedProfileId`.
- `POST /api/v1/profiles` creates a named Profile without selecting it.
- `GET /api/v1/profiles/:profileId` reads one explicit Profile, including
  secrets, behind management authentication.
- `PUT /api/v1/profiles/:profileId` fully replaces one explicit Profile.
- `PUT /api/v1/profiles/selection` explicitly changes `selectedProfileId`.
- `DELETE /api/v1/profiles/:profileId` deletes one non-default,
  non-selected Profile.
- `POST /api/v1/messages` sends one runtime message after configuration is
  ready.
- `GET /healthz` checks process liveness.
- `GET /api/v1/openapi.json` returns the generated OpenAPI document.

Management routes require the configured Bearer gateway token. `GET /api/v1/setup`
and `GET /healthz` remain anonymous so the setup UI can render before any
Profile is ready.

## Setup and restart behavior

Kaguya uses a v3 Profile Registry with one explicit `selectedProfileId`. On a
brand new configuration root, the bootstrap step creates the reserved empty
`default` Profile and selects it. The WebUI then drives Profile creation,
replacement, and selection as separate actions.

Selecting a Profile, or replacing the currently selected Profile, latches a
restart requirement. The UI surfaces `restart_required` only after the selected
Profile is ready. If the selected Profile is still `invalid` or
`review_required`, the setup page keeps showing readiness issues instead of a
restart prompt.

At the lower config-library layer, `inspect()` can still report
`setup_required` before bootstrap creates the registry. In the normal server
startup path, Kaguya bootstraps the empty registry first, so users typically
see `invalid`, `review_required`, `restart_required`, or `ready` from
`GET /api/v1/setup`.

## Historical scope of this directory

Older pages in this directory may still discuss MaiBot-specific route groups,
Cookie login flows, or system-control endpoints that are not part of Kaguya's
current server. Treat them as historical reference only unless a page has been
explicitly updated to mention `/api/v1/*`.

For the current runtime and configuration model, prefer:

- [Configuration guide](/manual/configuration/)
- [WebUI guide](/manual/webui/)
- [Message server and adapters](../message-server-and-adapters.md)
