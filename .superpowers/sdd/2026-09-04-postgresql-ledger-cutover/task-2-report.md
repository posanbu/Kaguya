# Task 2：重启恢复与 SQLite 运行时残留清理

本任务补足真实 PostgreSQL 测试在“进程第一次连接关闭后，再次连接同一数据库空间”这一场景的覆盖。此前测试 helper 将每一次 `KaguyaDatabase.close()` 视为 schema 的最终销毁，因此不能验证重启后仍可读取 ledger 事实和 pending outbox。本次将单次 pool 生命周期与 schema 生命周期分开，同时把静态架构门禁扩展到全部已退役的 SQLite 运行时标识。

## 实现

`packages/database/src/testing.ts` 新增 `createPostgresTestingDatabaseScope()` 和窄的 `PostgresTestingDatabaseScope` 接口。scope 的 `connect()` / `reconnect()` 以同一 schema 的 `search_path` 创建 pool；每一个返回的 `KaguyaDatabase.close()` 只关闭自己的 pool。仅 `scope.close()` 执行一次最终资源回收：关闭仍活动的 pool、`DROP SCHEMA ... CASCADE`，再关闭管理 pool。任一步失败时仍继续后续清理，并保留首个失败。

既有 `createPostgresTestingDatabase()` 保持原有调用契约：返回值关闭时仍会关闭 scope，故已有 PostgreSQL 合约和索引测试继续在用例结束后清理 schema。

`postgres-information-ledger.test.ts` 新增真实恢复回归：迁移、同步开启日志的 kind、追加原子及 outbox、关闭首个 pool、重新连接相同 schema，确认原子与 pending job 仍存在；新建 `InformationLogProjectionRunner` 后投递该 job 并确认 outbox 已清空。

架构扫描现禁止 `node:sqlite`、`DatabaseSync`、`.sqlite`、`databasePath`、`KAGUYA_DATABASE_PATH` 和 `KAGUYA_DEMO_DATABASE_PATH` 出现在 production TypeScript。Server 配置和配置测试删除 `KAGUYA_DATABASE_PATH`，而 server composition 测试将仅作临时目录锚点的 `databasePath` / `kaguya.sqlite` 改为 `workspaceRoot`。

## 修改文件

- `packages/database/src/testing.ts`
- `packages/database/src/postgres-information-ledger.test.ts`
- `scripts/information-architecture.test.ts`
- `apps/server/src/config.ts`
- `apps/server/src/config.test.ts`
- `apps/server/src/server-composition.test.ts`

## RED：失败证据

```text
$ pnpm vitest run scripts/information-architecture.test.ts apps/server/src/config.test.ts
Test Files  1 failed | 1 passed (2)
Tests  1 failed | 11 passed (12)
apps/server/src/config.ts:26: KAGUYA_DATABASE_PATH
```

```text
$ KAGUYA_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54329/postgres pnpm test:postgres
Test Files  1 failed | 1 passed (2)
Tests  1 failed | 25 passed (26)
TypeError: createPostgresTestingDatabaseScope is not a function
```

实际服务由任务上下文提供在 `127.0.0.1:54329`；简报示例中的 `5432` 没有在本工作环境监听，因此命令使用实际服务端口。

## GREEN：验证证据

```text
$ pnpm vitest run scripts/information-architecture.test.ts apps/server/src/config.test.ts apps/server/src/server-composition.test.ts
Test Files  3 passed (3)
Tests  26 passed (26)
```

```text
$ KAGUYA_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54329/postgres pnpm test:postgres
Test Files  2 passed (2)
Tests  26 passed (26)
```

```text
$ rg -n "node:sqlite|DatabaseSync|\\.sqlite|databasePath|KAGUYA_DATABASE_PATH|KAGUYA_DEMO_DATABASE_PATH" packages apps scripts --glob '*.ts' --glob '*.tsx' --glob '*.mjs' --glob '!*.test.ts' --glob '!*.test.tsx'
(no matches; rg exits 1 when no match is found)

$ pnpm typecheck
$ tsc -b --pretty false && pnpm --filter @kaguya/web typecheck
$ tsc --noEmit --pretty false
```

## 自检与关注点

逐项复核确认：scope 不会在 reconnect 时新建或清空 schema；连接关闭不会泄漏 pool；scope 的 `close()` 幂等且在失败路径仍尝试所有清理步骤；旧 factory 的关闭语义仍保留；静态扫描保留 docs 与测试文件排除规则。`git diff --check` 无空白错误。

唯一环境注意事项是 PostgreSQL 服务端口：本次使用任务上下文指定的 `54329`，而非简报示例的 `5432`。没有剩余代码层面的已知问题。

## Fix round 1：串行化 scope 打开与关闭

评审指出 `openConnection()` 在首次 await 之前只检查了 `#closed` 和 `#connection`，却没有占位 in-flight 打开状态。因此两个并发打开可各自创建 pool；并且 `close()` 可在打开恢复前完成，使后续调用把仍可用 pool 装入已关闭 scope。

实现新增私有 `#opening` promise。发起打开时立即记录该 promise，第二个 `connect()` 或 `reconnect()` 因 scope 已有活动或 in-flight 连接而被拒绝。`close()` 首先标记 closed，再等待 in-flight 打开 settle，最后关闭活动连接、删除 schema 与结束管理 pool。打开流程在创建 pool 后及健康检查后均重新检查 closed；若 scope 已关闭，会先关闭该 pool 再拒绝，因此不能把连接安装或交还给调用方。

真实 PostgreSQL 回归新增两项：并发 `connect()` / `reconnect()` 只有一个成功且最终关闭后该 pool 不可用；在 `connect()` 打开期间调用 `scope.close()` 后，打开 promise 不会交还数据库，且 scope 永远不能再次打开。

### 本轮 RED

```text
$ KAGUYA_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54329/postgres pnpm test:postgres
Test Files  1 failed | 1 passed (2)
Tests  2 failed | 26 passed (28)

does not lose a pool when connect and reconnect overlap
expected ... to have a length of 1 but got 2

does not return a usable pool when its scope closes while opening
promise resolved "{ rows: [ { '?column?': 1 } ], ... }" instead of rejecting
```

### 本轮 GREEN

```text
$ KAGUYA_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54329/postgres pnpm test:postgres
Test Files  2 passed (2)
Tests  28 passed (28)
```

```text
$ pnpm vitest run scripts/information-architecture.test.ts apps/server/src/config.test.ts apps/server/src/server-composition.test.ts
Test Files  3 passed (3)
Tests  26 passed (26)

$ pnpm typecheck
$ tsc -b --pretty false && pnpm --filter @kaguya/web typecheck
$ tsc --noEmit --pretty false
```

本轮 `git diff --check` 和 touched-file Prettier 检查均通过。未发现剩余 lifecycle 竞态；并发打开在第二个调用到达前即由 `#opening` 保留，关闭与打开重叠时则由关闭路径等待并收束该 promise。
