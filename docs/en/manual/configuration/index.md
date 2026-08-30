# Gateway Allowlist And Profile Setup

## Why this changed

Platform messages used to enter the Runtime, persist, and fan out to modules
before any gateway-level allowlist decision. That meant unauthorized traffic
could already have side effects even if a later reply module ignored it. The
older setup flow also treated only a missing config root as recoverable. If the
active profile was incomplete or had unacknowledged warnings, the Server could
stop before exposing a repair path in the same Web UI.

The current design fixes both edges together. Platform traffic is filtered at
the Runtime ingress boundary, and recoverable configuration states are exposed
through one Profile management surface in the Web UI. Unauthorized messages do
not enter the business pipeline, and selected-profile readiness failures show a
clear setup path instead of an unexplained exit.

## How it works now

Runtime uses `GatewayAllowlist` to evaluate platform messages by platform ID,
sender user ID, and target group ID. Unconfigured dimensions do not restrict
traffic; configured dimensions must all match. Filtering happens before message
persistence, event publication, and LLM work, and the system records a
credential-safe `message.dispatch.filtered` log entry. Web messages still carry
no platform identity and remain protected only by the gateway Bearer token.

The Server configuration exposes three comma-separated allowlist variables:

- `KAGUYA_GATEWAY_ALLOWLIST_PLATFORMS`
- `KAGUYA_GATEWAY_ALLOWLIST_USER_IDS`
- `KAGUYA_GATEWAY_ALLOWLIST_GROUP_IDS`

Configuration guidance now treats `setup_required`, `invalid`,
`review_required`, and `restart_required` as explicit UI states around the
selected Profile. When the selected Profile is not ready, the Server starts
only HTTP and the Web UI, keeps Runtime and NapCat paused, and exposes
secret-free setup status through `GET /api/v1/setup`.

Configuration writes no longer go through `POST /api/v1/setup`. The Web UI now
uses the Profile management routes:

- `GET /api/v1/profiles` for metadata plus `selectedProfileId`
- `POST /api/v1/profiles` to create a named Profile
- `GET /api/v1/profiles/:profileId` to load the full secret-bearing Profile
- `PUT /api/v1/profiles/:profileId` to replace one Profile completely
- `PUT /api/v1/profiles/selection` to change `selectedProfileId`
- `DELETE /api/v1/profiles/:profileId` to delete an allowed Profile

On a brand new root, the explicit bootstrap step creates an empty reserved
`default` Profile and sets `selectedProfileId` to `"default"`. Users can then
configure `default` or create another named Profile and select it explicitly.

The Web UI checks setup status before exposing chat. When configuration is
required, it opens the Profile management screen, loads the current selected
Profile by ID, and edits the complete Profile body rather than overwriting
hidden fields with a blank form. API keys are not stored in browser storage.
If a save or selection leaves the selected Profile in `invalid` or
`review_required`, the UI continues to show readiness issues and warnings
instead of prompting for a restart. Selecting a Profile or replacing the
currently selected Profile latches a restart requirement, and the UI surfaces
`restart_required` once that selected Profile is ready. At that point the user
restarts the Server so Runtime can load the selected Profile on the next
startup.

## Safety boundaries remain intact

The recoverable setup path only handles missing or incomplete selected-profile
configuration plus explicit warning acknowledgement. Corrupt indexes, missing
Profile files, path traversal, symlinks, and permission failures still block
startup so the system does not overwrite data that may require manual recovery.

`KAGUYA_GATEWAY_TOKEN` is still required before the Server accepts authenticated
configuration writes. Anonymous setup mode exposes only metadata, readiness
issues, and warnings. Complete Profile reads and writes still require
management authentication. Profile replacement continues to use strict schema
validation, and the Server still verifies that `light` and `heavy` map to
different targets.

## Documentation status

The live configuration and server docs now describe the v3 registry contract:
one explicit `selectedProfileId`, setup status through `GET /api/v1/setup`,
Profile mutations through `/api/v1/profiles*`, and `restart_required`
activation for selected-Profile changes once that selected Profile is ready.
