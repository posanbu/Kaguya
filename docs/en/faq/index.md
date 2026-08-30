# Remaining work

Issue #37 is complete in the current Runtime: ingress carries only message
content and an ingress receipt, while Core, the SDK, configuration, and the new
SQLite format maintain no conversation-group identifier. Legacy configuration
indexes and databases are rejected explicitly and are never migrated or
deleted automatically.

## Implementation order

1. **#38 Information atoms and Kind Registry**
   - Define the information-atom contract with `informationId` as its identifier.
   - Register and validate payload Kinds, with explicit typed references between information IDs.
2. **#39 Async ledger, SQLite, and log projections**
   - Make the append-only information ledger the source of truth.
   - Implement the storage abstraction in SQLite first; runtime logs are projections, never the reverse source of truth.
3. **#40 Core DAG and module SDK**
   - Modules explicitly subscribe to input Kinds and produce output Kinds.
   - Core validates types and handles DAG scheduling, causality, and failure propagation without inferring a processing chain.
4. **#41 Selector, Prompt, and Memory**
   - Selectors choose context through explicit information references.
   - Prompt provenance and Memory build on information atoms and the ledger without restoring implicit grouping.
5. **#42 PostgreSQL transition**
   - Move the source-of-truth store to PostgreSQL after the storage and ledger contracts stabilize.
   - Preserve information IDs, Kinds, references, and projection semantics.

## Current constraints

- `messageId`, `eventId`, `traceId`, and Web `requestId` remain temporarily and will converge under #38 and #40.
- Platform senders, groups, and platform message IDs are source and delivery information, not Core grouping keys.
- There is no persistent event queue, automatic retry, deduplication, hot reload, module sandbox, or legacy Memory placeholder workflow.
- New work must preserve strict schemas, protected causal lineage, Prompt provenance, structured-log redaction, and side-effect-free startup failure.

## Acceptance baseline

- Duplicate, out-of-order, and failed handling produces no unaudited business effects.
- Every output can be traced to its inputs through information references and causal edges.
- Logs and projections contain no provider credentials, message bodies, or unauthorized sensitive content.
- Before switching to PostgreSQL, the same storage contract suite must cover SQLite and the target implementation.
