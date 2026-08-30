---
title: System Control
---

# System Control

This page is a legacy-reference note. The old MaiBot
`/api/webui/system/*` endpoints documented in previous revisions are not part
of Kaguya's current Fastify gateway.

## What Kaguya exposes today

Kaguya's live HTTP surface is intentionally smaller:

- `GET /healthz` for liveness
- `GET /api/v1/setup` for anonymous readiness and selected-profile metadata
- `GET /api/v1/openapi.json` for the generated contract
- authenticated `/api/v1/profiles*` routes for Profile management
- authenticated `POST /api/v1/messages` for runtime ingress

There is no documented Kaguya replacement for the old public
`/api/webui/system/restart`, `/api/webui/system/reload-config`, cache cleanup,
or update-notice endpoints in this repository.

## Operational implication

Changing the selected Profile, or replacing the currently selected Profile,
does not hot-swap Runtime state. Once the selected Profile is ready, the WebUI
surfaces `restart_required`; operators then restart the Kaguya process through
their normal host/process manager so the next startup snapshot uses the new
global Profile.

If the selected Profile remains incomplete, `GET /api/v1/setup` keeps reporting
readiness issues and the UI does not prompt for restart yet.

## Historical note

If you need to study the older MaiBot system-control design for migration or
comparison, use it as archival context only. Do not implement automation
against those routes for Kaguya unless the server code adds them back and the
docs are updated accordingly.
