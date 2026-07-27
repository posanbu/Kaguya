# 贡献指南

## 环境准备

仓库锁定 Node.js 24.18.0 和 pnpm 11.9.0。不要使用相近的大版本代替：项目依赖 `node:sqlite`，并以固定版本作为本地与 CI 的共同基线。

使用 nvm：

```bash
nvm install
nvm use
node --version
```

使用 fnm：

```bash
fnm install
fnm use
node --version
```

nvm 读取 `.nvmrc`，fnm 读取 `.node-version`；两者都应显示 `v24.18.0`。然后通过 Corepack 启用仓库声明的 pnpm：

```bash
corepack enable
corepack install --global pnpm@11.9.0
pnpm --version
pnpm install
```

`pnpm --version` 应为 `11.9.0`。依赖版本由 `pnpm-lock.yaml` 管理，不要改用 npm 或 yarn 安装。

## 敏感配置文件

本地示例统一使用 `.data/kaguya-config`，生产环境应使用仓库外、仅运行账号可访问的绝对路径。配置目录、`index.json` 和全部 profile JSON 都是敏感文件，因为其中的 API key、平台凭据和插件密钥以明文保存。

在 POSIX 系统中目录必须为 `0700`、文件必须为 `0600`。Windows 部署必须由管理员设置只允许运行身份访问的 NTFS ACL。每个配置根目录在任意时刻必须恰好只有一个活跃的 `FileUserConfigManager`/writer 实例，包括同一进程内；当前实现既不支持多个 manager 实例之间的协调，也不支持跨进程协调。

禁止把真实配置复制进测试、日志、Issue、PR 或聊天记录。测试只使用 `test-only-placeholder` 一类无效值。如果密钥进入 Git，先撤销或轮换密钥，再评估访问记录并按需清理仓库历史；仅添加 `.gitignore` 或删除最新版本不能使已泄漏密钥恢复安全。

备份、压缩包和故障现场副本仍然是敏感数据，必须限制访问并加密保存。

## 日志规范

运行时代码使用 `@kaguya/logger`，不要新增 `console.log/error` 或自行构造另一套 JSON logger。应用入口创建根 Logger，模块通过 `createModuleLogger()` 创建 child Logger；跨模块调用使用 `runWithLogContext()` 传播仓库约定的关联 ID。

日志对象必须提供稳定 `event` 字段，不把用户消息、Prompt、模型回答、HTTP body/headers、完整 provider URL、凭证或原始 provider Error 写入普通日志。默认 redaction 和安全 serializer 只是兜底；新增字段时仍须检查数据敏感性，并补充不会泄漏测试。高吞吐进程启用 worker transport 时，正常关闭必须调用 `closeLogger()`。

## 开发命令

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm prompt:test
pnpm demo
```

- `build` 构建所有 TypeScript project references，并更新各包的 `dist/`。
- `typecheck` 使用 `tsc -b` 的 build mode 检查类型，也可能更新 `dist/` 和增量构建信息；它不是 no-emit 检查，也不替代测试。
- `lint` 检查 TypeScript、JavaScript 和 CommonJS 辅助脚本。
- `test` 运行 Vitest 单元与集成测试。
- `prompt:test` 通过 `tsx` source bridge 调用 `packages/prompt/src/index.ts` 的实际编译器；自定义 provider 不创建模型、不访问网络，也不需要密钥。固定的 Promptfoo 0.121.19 在 telemetry disabled 时仍可能尝试上报禁用事件，因此脚本既设置 telemetry/update disable 标志，也把大小写 HTTP(S)/ALL proxy 指向不可达的 `127.0.0.1:9` 并清空 `NO_PROXY`，阻止 CLI 请求离开 localhost。
- `demo` 使用确定性 mock model，把示例结果写入 `.data/kaguya-demo.sqlite`。

格式化命令：

```bash
pnpm format
pnpm format:check
```

## TDD 与回归测试

功能和修复都遵循小步 RED、GREEN、REFACTOR：

1. 先写能表达外部行为的测试，并确认它因预期原因失败。
2. 实现让测试通过的最小改动。
3. 在测试保持绿色时整理命名、边界和重复代码。
4. 运行受影响包的测试，再运行根目录完整测试。

修复 bug 时必须先加入能复现该 bug 的回归测试。测试应断言公开结果、持久化记录或 trace，不要只断言内部调用次数。涉及时间、ID、数据库或模型时使用可注入时钟、ID 生成器、临时 SQLite 和确定性模型；测试中禁止真实等待、网络请求和 API key。

配置包改动先运行聚焦检查：

```bash
pnpm vitest run packages/config/src
pnpm --filter @kaguya/config typecheck
```

配置测试只能使用 `test-only-placeholder` 一类占位值，绝不能读取真实本地配置根目录。新增或修改 readiness/error 断言时，必须验证输出不含任何明文 credential（包括 API key）。

Prompt 变更同样先修改 `promptfooconfig.yaml` 的输入和 `promptfoo/assertions.cjs` 的结构断言，确认失败后再改编译或组装逻辑。断言应验证片段来源、ID、顺序和内容，不能只做宽泛的关键词存在检查。

## 新增 workspace 包

新包放在 `packages/<name>/`，应用放在 `apps/<name>/`。新增基础包的最小文件通常是：

```text
packages/example/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts
    └── index.test.ts
```

`package.json` 应使用 ESM、私有 workspace 包和明确的导出：

```json
{
  "name": "@kaguya/example",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc -b --pretty false"
  }
}
```

`tsconfig.json` 继承根配置并启用 composite；需要引用其他 workspace 包时，同时更新 `references`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"],
  "references": [{ "path": "../schema" }]
}
```

还要把新项目加入根 `tsconfig.json`：

```json
{
  "references": [{ "path": "./packages/example" }]
}
```

用 workspace 协议添加内部依赖，避免手改 lockfile：

```bash
pnpm --filter @kaguya/example add "@kaguya/schema@workspace:*"
pnpm install
pnpm build
```

如果只增加 TypeScript reference 而漏掉 `package.json` 依赖，编译结果可能与包管理器解析结果不一致；两处必须同步。

## 包依赖规则

- `schema` 只定义跨包数据契约，不依赖其他 Kaguya 包。
- `sdk` 可以依赖 `schema`，公开声明式定义 API，不包含运行时基础设施。
- `engine` 可以依赖 `sdk` 和 `schema`，不导入应用或具体数据库/LLM 实现。
- `scheduler`、`prompt`、`llm`、`database` 通过 `schema` 共享契约，彼此不形成环。
- `apps/*` 是 composition root，可以依赖所有基础包并注入 services。
- 基础包不得导入 `apps/*`，不得通过相对路径越过另一个包的公开入口。
- 供应商 SDK 只能存在于相应适配边界；业务工作流不直接导入模型供应商。
- SQL、迁移和数据库行映射只放在 `@kaguya/database`。

确需增加跨包依赖时，先确认方向仍然单向，并在 `docs/architecture.md` 更新依赖图。

## SQLite 迁移

迁移位于 `packages/database/src/migrations.ts`。修改规则：

1. 已发布的 migration SQL 不得重写；新增一个更高且唯一的整数版本。
2. 每个版本必须能从上一版本前向执行，不能依赖手工编辑数据库。
3. 多条 DDL 与 `schema_migrations` 记录在同一个 `BEGIN IMMEDIATE` 事务中完成；失败必须回滚。
4. SQL 使用参数化查询处理值，表名或列名等结构信息不能来自不可信输入。
5. 同一数据库重复启动不得重复应用版本；为升级、重复运行和 repository 往返各写测试。
6. 新字段需要更新 schema、repository 写入、行重建、错误校验和相应测试。
7. 不在迁移中删除用户数据；确需破坏性变更时先提供迁移/备份方案并单独评审。

不要在应用或其他包中执行临时 `ALTER TABLE`，也不要绕过 repository 直接拼接业务 SQL。

## 文档要求

代码与文档同一提交更新：

- 公开 API、事件字段、节点或依赖改变时更新 `docs/architecture.md`。
- 新增或改变 MaiBot 借鉴逻辑时更新 `docs/maibot-analysis.md`，写明源文件和运行状态。
- 环境、命令或开发规范改变时更新本文件与 README。
- Prompt 变化时同时更新 Promptfoo 用例及其断言原因。
- Mermaid 图应反映实际可达代码，不把注释、兼容分支或未来计划画成当前主链。

## 提交前检查

提交前从仓库根目录运行：

```bash
pnpm format
pnpm format:check
pnpm lint
pnpm test
pnpm prompt:test
pnpm build
pnpm typecheck
git status --short
git diff --check
```

最后确认：

- 失败用例曾以预期原因变红，新实现和回归测试均为绿色；
- 没有密钥、模型响应、个人数据库、日志或 `data/` 产物被提交；
- 没有无关文件或其他人的工作树改动被暂存；
- 新包、依赖、TypeScript reference、lockfile 与架构文档保持一致；
- 所有新事件、Prompt 和 LLM 调用都能通过 `traceId` 追踪；
- commit message 说明用户可见的结果，而不是只描述实现手段。
