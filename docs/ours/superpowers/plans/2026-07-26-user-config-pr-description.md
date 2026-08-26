# User Configuration PR Description Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a concise Chinese GitHub Pull Request description covering only the user configuration management feature.

**Architecture:** Add one standalone Markdown document that can be copied directly into GitHub. It summarizes delivered behavior, verification evidence, and operational limitations without describing repository initialization or claiming unimplemented integrations.

**Tech Stack:** Markdown, Prettier, Git

## Global Constraints

- Create only `docs/pull-request-user-config.md`.
- Do not include repository initialization or monorepo scaffolding.
- Do not include real credentials, local paths, internal review history, or commit-by-commit narration.
- Do not claim that a PR was created or pushed.
- Preserve the untracked `docs/SDK.md` without modification or staging.

---

### Task 1: Write the User Configuration PR Description

**Files:**

- Create: `docs/pull-request-user-config.md`

**Interfaces:**

- Consumes: the implemented `@kaguya/config` behavior and final verification results.
- Produces: a Markdown description that can be pasted directly into a GitHub Pull Request.

- [ ] **Step 1: Verify that the target document does not exist**

Run:

```bash
test ! -e docs/pull-request-user-config.md
```

Expected: exit code 0.

- [ ] **Step 2: Create the PR description**

Create `docs/pull-request-user-config.md` with exactly this content:

```md
# 用户配置管理

## Summary

新增统一的用户配置管理层，支持保存多份配置、设置默认配置，并按会话选择使用的配置。每份配置包含 AI、平台和插件设置。

## Changes

- 新增 `@kaguya/config` TypeScript 包及配置 schema。
- 支持配置的创建、读取、完整更新、删除和默认配置管理。
- 支持会话绑定、解绑，以及未绑定会话的默认配置回退。
- 使用敏感 JSON 文件持久化明文密钥，并提供原子写入、路径与符号链接防护、POSIX 权限加固、损坏检测和递归脱敏。
- 补充配置使用、安全边界和后续集成文档。

## Validation

- Vitest：247/247
- Promptfoo：4/4
- `pnpm lint`
- `pnpm build`
- `pnpm typecheck`
- 所有已跟踪文件通过 Prettier 检查

## Known limitations

- API key、平台凭据和插件密钥以明文 JSON 保存，整个配置根目录都必须作为敏感数据管理。
- 每个配置根目录只能有一个活跃的 manager/writer；当前不提供跨实例或跨进程协调。
- Windows 部署需要人工设置仅允许运行身份访问的 NTFS ACL。
- 配置 UI、模型提供方执行、平台适配器和插件运行时接线仍不在本次范围内。
```

- [ ] **Step 3: Verify formatting and scope**

Run:

```bash
pnpm exec prettier --check docs/pull-request-user-config.md
rg -n "Summary|Changes|Validation|Known limitations" docs/pull-request-user-config.md
git diff --check -- docs/pull-request-user-config.md
git status --short
```

Expected:

- Prettier and `git diff --check` exit 0.
- All four section headings are present.
- `git status --short` lists the new PR description and the pre-existing untracked `docs/SDK.md`.

- [ ] **Step 4: Inspect and commit only the PR description**

Run:

```bash
git diff -- docs/pull-request-user-config.md
git add docs/pull-request-user-config.md
git diff --cached --check
git commit -m "docs: add user config PR description"
```

Expected: the commit contains only `docs/pull-request-user-config.md`; `docs/SDK.md` remains untracked and unstaged.
