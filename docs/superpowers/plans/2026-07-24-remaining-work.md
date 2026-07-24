# Kaguya Remaining Work Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a practical Chinese roadmap that separates Kaguya's completed 3.1 infrastructure from the human decisions and engineering work required for production use.

**Architecture:** Add one canonical roadmap at `docs/remaining-work.md` using a P0/P1/P2 delivery sequence plus repeatable subsystem task cards. Link it from the README so project owners can plan milestones while developers can turn each card into an issue with explicit dependencies and acceptance criteria.

**Tech Stack:** Markdown, Mermaid, Prettier, Git

## Global Constraints

- Write for both project owners and developers.
- Distinguish `人工决策` from `工程实现`; do not disguise undecided production choices as defaults.
- Describe the existing demo and packages accurately without treating them as production adapters, queues, storage, scheduling, deployment, or operations.
- Give priorities and dependencies, but no unvalidated calendar estimates or staffing promises.
- Do not include real credentials, provider secrets, or a forced vendor choice.
- Preserve existing package boundaries and use absolute repository paths only in commands, not in committed Markdown links.

---

### Task 1: Create the remaining-work roadmap and make it discoverable

**Files:**

- Create: `docs/remaining-work.md`
- Modify: `README.md:70`

**Interfaces:**

- Consumes: the implemented boundaries documented in `docs/architecture.md`, the MaiBot findings in `docs/maibot-analysis.md`, and the approved structure in `docs/superpowers/specs/2026-07-24-remaining-work-design.md`.
- Produces: one canonical roadmap linked as `docs/remaining-work.md` from the README documentation list.

- [ ] **Step 1: Write the baseline and reading guide**

Create `docs/remaining-work.md` with these opening sections:

```markdown
# Kaguya 仍需人工实现的部分

## 如何阅读本文

本文从 3.1 init commit 的现状出发，区分两类未完成工作：

- **人工决策**：需要产品、安全、运维或领域负责人确认的规则。
- **工程实现**：决策确定后可以编码、测试和部署的能力。

P0 表示真实平台最小闭环，P1 表示可维护与可恢复，P2 表示按产品需要扩展。优先级不是工期承诺。

## 已有基础，不需要重做
```

Under `已有基础，不需要重做`, explicitly preserve:

- `@kaguya/schema` event and record contracts;
- `@kaguya/sdk` event/listener/node/workflow declarations;
- `@kaguya/engine` validated in-process EventBus and DAG execution;
- `@kaguya/scheduler` manual/interval/cron primitives;
- `@kaguya/prompt` stable compilation and provenance;
- `@kaguya/llm` response validation, normalized errors, and traces;
- `@kaguya/database` SQLite migrations and repositories;
- the three deterministic workflows and Promptfoo structural cases.

State that these are reusable foundations, not evidence that production integrations already exist.

- [ ] **Step 2: Add the P0 milestone and task cards**

Add:

```markdown
## P0：真实平台最小闭环
```

Use one Mermaid dependency flow with these nodes in order:

```text
product decisions -> platform adapter -> production storage
product decisions -> real LLM -> business prompts
platform adapter + storage + real LLM + prompts -> deployed application
deployed application -> scheduler/operations
```

Create separate task cards for:

1. 产品和运行边界；
2. 平台入站与消息发送适配器；
3. 真实 LLM provider 与模型策略；
4. 人格、路由、回复、状态和 memory Prompt；
5. 生产数据存储与数据治理；
6. 常驻调度、部署和运行配置。

Every card must contain the same seven subheadings:

```markdown
### P0.x 标题

**当前基础**

**为什么必须人工参与**

**人工决策**

**工程交付物**

**依赖**

**推荐角色**

**验收标准**
```

Acceptance criteria must be observable. P0 as a whole is complete only when a real platform message enters through a validated event, uses an approved Prompt and real model, persists through production storage, sends a response through the platform API, and heartbeat/memory schedules survive process operation.

- [ ] **Step 3: Add P1 reliability and evaluation task cards**

Add:

```markdown
## P1：可维护、可恢复、可评估
```

Create task cards using the same seven subheadings for:

1. durable queue/outbox, idempotency, retry, dead-letter handling, and crash recovery;
2. structured logs, metrics, distributed traces, alerts, and a runbook;
3. Promptfoo production-like datasets, quality thresholds, cost/latency limits, and release gates;
4. memory retrieval, ranking, compression, deletion, and provider/storage choice;
5. authenticated management API/UI for status, trace inspection, configuration, and safe operations;
6. security review covering secrets, permissions, content/data sensitivity, retention, deletion, and audit.

State that P1 is complete only when failures are observable and recoverable, duplicate delivery is safe, and Prompt/model changes are blocked when the agreed regression thresholds fail.

- [ ] **Step 4: Add P2 expansion directions and entry conditions**

Add:

```markdown
## P2：按产品需求扩展
```

Cover these directions without presenting them as committed scope:

- more messaging platforms;
- image, audio, emoji, and file inputs/outputs;
- tools, plugins, and external service calls;
- authorization, tenant isolation, and audit;
- multi-instance scheduling and horizontal scaling.

For each direction, state the product signal or capacity threshold that should exist before implementation begins. Do not prescribe a vendor.

- [ ] **Step 5: Add decision records, issue checklist, and ownership guidance**

Add:

```markdown
## 需要团队先确认的决策

## 可直接转为 GitHub Issues 的检查表

## 建议的角色分工

## 完成定义
```

The decision section must include:

- supported platform and account/permission model;
- response behavior and safety policy;
- provider/model/cost/latency targets;
- data classification, retention, deletion, and backup recovery objectives;
- deployment environment and availability objectives;
- memory quality and user-control expectations.

The issue checklist must use unchecked Markdown checkboxes, identify P0/P1/P2, and keep each item to one independently verifiable deliverable.

The role section should recommend roles such as product/domain owner, platform integration engineer, AI/Prompt owner, backend/data engineer, SRE/security, and UI engineer without assigning named individuals.

The completion definition must distinguish:

- P0 production-loop completion;
- P1 operational-readiness completion;
- optional P2 feature completion.

- [ ] **Step 6: Link the roadmap from README**

Add this item under `README.md` → `## 文档`, after the architecture link:

```markdown
- [人工待实现路线图](docs/remaining-work.md)：生产闭环、可靠性与后续扩展所需的人工决策、工程任务和验收标准。
```

- [ ] **Step 7: Check consistency and formatting**

Run:

```bash
rg -n "待补充|稍后决定|后续完善|视情况" docs/remaining-work.md
```

Expected: no output. The GitHub issue checklist uses concrete task text rather than the banned placeholders.

Run:

```bash
pnpm exec prettier --check docs/remaining-work.md README.md
git diff --check
```

Expected: both commands exit 0.

Manually verify:

- every P0/P1 card has all seven required subheadings;
- demo behavior is never called production-ready;
- priorities and dependencies do not contradict the Mermaid flow;
- the roadmap does not duplicate the detailed architecture explanation;
- all relative links resolve inside the repository.

- [ ] **Step 8: Commit the completed documentation**

```bash
git add docs/remaining-work.md README.md
git commit -m "docs: add remaining implementation roadmap"
```

Expected: the commit contains only `docs/remaining-work.md` and `README.md`.
