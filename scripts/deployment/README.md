# 离线升级、恢复与单实例接管

这些入口准备 #304 的停写升级及恢复验收。正式切换必须使用集成验收后的 GitHub main SHA；管理员先关闭新任务准入、排空或记录在途任务，并阻止旧 supervisor 自动拉起。脚本不会停应用、操作 NapCat、发送消息或调用模型。原生 Memory recover 是另一个显式业务步骤，不属于 Schema 迁移。

`offline-upgrade.ts` 提供只读 `inspect/verify` 和显式 `apply`。`recovery.py` 提供备份、字节校验、新 scratch 恢复、旧事实比较及兼容回退检查。`single_owner.py` 作为 systemd 的唯一前台入口持有数据库 advisory lock 3041107；离线迁移使用相同锁。

## 输入与权限

所有 plan/target/receipt 文件必须由操作者持有并为 0600。外层备份目录为 0700。连接信息只从私有文件读取；输出不会包含连接串、SQL 正文、聊天或凭据。`inspect/verify` 不修复文件权限。

`recovery.py` 使用 PostgreSQL 17 原生命令。`pg_bin` 指向同一套 `psql/pg_dump/pg_dumpall/pg_restore/initdb/pg_ctl`。数据库账号须可读取全部表、全局角色及 `pg_control_system()`。source 使用受限 libpq service 文件；不能用个人默认 PG 环境隐式选库。备份前确认 `pg_tablespace` 只有默认表空间；自定义表空间必须另做管理员恢复设计。

`asset_roots` 必须显式列出 `config`、`media` 和 `tools`，可以增加其他根。没有媒体或工具产物时使用实际存在的空目录，不省略字段。拒绝符号链接/特殊文件；保留文件字节、模式、UID/GID和空目录。复制后的元数据不一致会停止。跨 UID/GID 的 broker 卷须由管理员提供保持所有权的可读备份方案，本入口不会用 chown 掩盖差异。

plan 的字段示例（填入现场核验值后保存为 0600）：

```json
{
  "version": 1,
  "pg_bin": "/absolute/postgresql17/bin",
  "service_file": "/private/pg_service.conf",
  "pass_file": "/private/pgpass",
  "source": {
    "service": "reviewed_source",
    "identity": {
      "system_identifier": "REPLACE_FROM_PG_CONTROL_SYSTEM",
      "database": "kaguya",
      "data_directory": "/absolute/verified/pgdata",
      "socket_directory": "/absolute/verified/socket",
      "port": "5432"
    }
  },
  "schema": "public",
  "systemd_scope": "user",
  "application_unit": "kaguya.service",
  "asset_roots": {
    "config": "/absolute/config",
    "media": "/absolute/media",
    "tools": "/absolute/tools-artifacts"
  },
  "configuration_review": {
    "cordisSha256": "REPLACE_WITH_64_HEX",
    "pluginNames": ["kaguya/runtime"]
  }
}
```

`pluginNames` 必须准确列出 cordis.yml 的全部插件。CLI 纯解析 YAML 后核验列表和文件哈希；第三方插件需要单独的静态声明审查。现有一方模块声明含历史兼容 Kind 和 MCP 延迟结果，不运行插件工厂。

## 备份与离线迁移

以下命令是验收入口，需先填入已审查的绝对路径。任何前置检查失败均停止后续步骤。

```sh
python3 -B -I scripts/deployment/recovery.py backup \
  --plan /private/source-plan.json --directory /private/new-backup
```

备份要求服务已停止、MainPID=0、无其他数据库客户端、无 prepared transactions。持锁后保存 custom dump、globals、全部资产及逐表原列 SHA-256；同时保存 sequence、epoch、raw checkpoint/rejections、revision、队列、delivery attempts、commit-slot、media 等所有现存表。备份前后比较相同投影，期间变化即失败。receipt 最后写入，不完整目录不能当作成功备份。保存输出的 receipt SHA 到独立验收记录。

```sh
python3 -B -I scripts/deployment/recovery.py verify \
  --plan /private/source-plan.json --directory /private/new-backup \
  --receipt-sha256 VERIFIED_RECEIPT_SHA &&
python3 -B -I scripts/deployment/recovery.py stopped-receipt \
  --plan /private/source-plan.json --directory /private/fresh-stopped.json
```

离线 target 文件格式由 `offlineTargetSchema` 定义，包含 connectionString、expectedSystemIdentifier、expectedDatabase、expectedDataDirectory、configRoot、firstPartyOnly、configurationReview、backupReceipt 和 stoppedReceipt。两回执均按 path+sha256引用。停止回执有效期十分钟；过期重新采集，不修改旧回执的时间。

```sh
node apps/server/dist/offline-upgrade.js inspect --target-file /private/offline-target.json &&
node apps/server/dist/offline-upgrade.js apply --target-file /private/offline-target.json
```

`apply` 在单一数据库事务中复用全部 Schema 函数及完整 Kind 契约同步。已存在的 epoch 缺失、Raw 表只剩一部分、缺列/主键/外键/关键唯一索引等情况会拒绝。Lifecycle 文件迁移使用独立 journal，合法旧 `false/120000` 和其他设置保持；journal 写后数据库提交失败时，保留 journal，重新审查新 cordis 哈希再重放。

配置首次迁移会改变 cordis.yml。审核新 tree/设置后更新 target 的 configurationReview；再执行 `verify`、第二次 `apply` 和第二次 `verify`，证明幂等。不能把校验陈旧配置哈希的失败当作迁移失败，也不能绕过审查。

```sh
node apps/server/dist/offline-upgrade.js verify --target-file /private/reviewed-target.json &&
python3 -B -I scripts/deployment/recovery.py compare \
  --plan /private/source-plan.json --directory /private/new-backup \
  --receipt-sha256 VERIFIED_RECEIPT_SHA
```

比较允许 Kind 契约的受控同步；具体契约由 CLI 检查。observation_progress 仅允许源码中已有 GREATEST 水位归一：预先计算变换后的行指纹，仍核对每一原列；不是跳过整张表。其余原列及已有 sequence 必须逐字节相同。

## 新建 scratch 恢复

先审查 globals.sql、dump 的扩展/角色/所有者和来源可信性，记录 globals SHA。恢复会执行 dump 中的 SQL；目录私有不代替 SQL 审查。使用独立本地 PG17，UTF8、C.UTF-8，关闭 TCP，仅创建专属 0700 Unix socket。权限与 locale/扩展不满足时停止，不使用 `--no-owner`、`--clean` 或回退到生产。

```sh
python3 -B -I scripts/deployment/recovery.py restore \
  --plan /private/source-plan.json --directory /private/new-backup \
  --receipt-sha256 VERIFIED_RECEIPT_SHA \
  --reviewed-globals-sha256 REVIEWED_GLOBALS_SHA \
  --scratch /private/new-scratch
```

只接受不存在且与源数据、配置、媒体、工具、release及备份目录不相交的路径。新集群 system identifier 必须不同于备份源；每次重连核对 system ID、数据库、data/socket目录、端口。恢复原 ownership、sequence、角色、所有资产，比较结构与全库原列指纹后再出回执。然后在 scratch 重新备份，生成绑定 scratch 身份的 `migration-backup/receipt.json`、`stopped-receipt.json`、`offline-target.json` 与 `recovery-plan.json`。原生产回执不能直接授权 scratch 写入。

命令结束会停止本次 scratch PG，保留全部产物；启动失败也尝试清理该新目录。后续隔离演练由集成者只启动这个已核验目录，沿用 restore-receipt 中的 socket/user/database，使用生成的 target 执行 inspect→apply→verify→apply→verify。十分钟停止回执过期时，重新记录该 scratch 无 Runtime/无其他客户端的证据并生成新停止回执，不能把生产停止状态代替 scratch 状态。

## 兼容回退与副作用核对

普通回退沿用当前数据库及全部新增事实/资产，不恢复旧 dump。先停新领取并记录 in-flight/unknown，再停 Runtime；对当前（已包含升级后新数据）状态重新 `backup`，在新 scratch 上用拟回退 SHA 验证 schema、Kind、配置和最新数据兼容。回执绑定该最新备份 SHA及完整 `candidate_sha`，记录 `verified_on_scratch=true` 与 `pending_unknown_reconciled=true`。plan 增加 `rollback_sha`。

```sh
python3 -B -I scripts/deployment/recovery.py rollback-check \
  --plan /private/rollback-plan.json --directory /private/latest-backup \
  --receipt-sha256 LATEST_RECEIPT_SHA \
  --compatibility-receipt /private/rollback-compatibility.json
```

检查当前全库原列、sequence及结构仍等于被验收的最新快照后才输出成功。本命令不自动启动旧程序。旧 SHA 无法理解新增契约或队列时，保持停止，改用向前修复。

灾难恢复到早期数据库恢复点是另一项管理员动作。先保留恢复点后的完整库及媒体/工具产物；逐项记录 delivery.started、receipt、工具 dispatch/receipt、unknown 和外部可查结果，再决定接受、补录或继续核对。没有确认结果时不盲重发旧正文或工具调用。本工具只恢复 scratch，不提供覆盖生产数据库命令。

## 单实例接管

仅在管理员批准后，把专属 systemd `kaguya.service` 的 ExecStart 指向 `single_owner.py --plan ... -- /absolute/node /release/apps/server/dist/server.js`。要求独立 cgroup v2，`KillMode=control-group`；禁止把多个不相关服务放入同一控制组。旧入口及其自动拉起必须先停用。

plan 增加 release_root、release_receipt、release_receipt_sha256。回执必须包含 accepted_main_sha、migration_verified、required_ci_passed、administrator_takeover_approved、精确 runtime_argv、database_identity，以及非空 runtime_files（相对 release root 的路径与 SHA-256）。集成者应列入完整运行产物和依赖清单；只列入口文件不能证明整个发布包未变。

wrapper 核对 checkout SHA、运行文件、目标库身份后持锁启动。每次心跳检查同一 PostgreSQL backend 仍持锁；失联/超时会结束 Runtime。退出时清理专属 cgroup 的全部后代（包含另建进程组的 MCP），保留 wrapper 和持锁 psql，清理后才释放锁。无法排空时持续持锁等待管理员。锁失联期间已有外部请求仍可能完成；它们必须保留 unknown 并核对，不能把互斥锁解释成外部 exactly-once。

## 验收入口

```sh
python3 -B -I scripts/deployment/test_recovery.py
pnpm exec tsc -b
pnpm exec vitest run apps/server/src/offline-upgrade.test.ts apps/server/src/lifecycle-migration.test.ts
```

真实 Linux/PG17还须验证：合成数据库备份→恢复→两次迁移；每次 DDL/配置 journal 注入中断后重入；epoch/raw/revisions/队列/媒体与权限保持；旧版本兼容回退保留新增事实；两个 wrapper 互斥；持锁 backend 被终止时子进程收敛；MCP detached 子进程退出；TERM 被忽略时有界进入 KILL；错误集群/配置/回执/宽权限均拒绝。源数据不得进入 fixture、终端正文或外部模型。

`pg_restore --create` 的目标数据库名取自 archive，`--dbname` 只选创建数据库时的初始连接。因此本工具先检查 archive 来源回执、使用新的独立集群，并在恢复后再次核对实际数据库身份。参见 [PostgreSQL 17 pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html) 和 [initdb](https://www.postgresql.org/docs/17/app-initdb.html)。

## 专用容器的非空恢复验收

`check_postgres_restore.py` 使用已缓存的 `postgres:17-alpine` 创建两个本任务专用容器，端口仅绑定 loopback。它不连接现有服务或其他任务数据库，也不拉取镜像。容器启动按 `pg_isready` 的 TCP 就绪条件有界等待；退出时只停止本次容器，保留数据库及证据。

```sh
python3 -B -I scripts/deployment/check_postgres_restore.py \
  --repo /absolute/Kaguya \
  --node /absolute/node24 \
  --directory /absolute/new-private-drill-directory
```

在本批并行工作中，外层使用 `run-targeted.py --task deployment304 --` 获取两槽额度。脚本通过私有 tsx paths 配置映射所有 Kaguya workspace package 到当前源码，避免部分构建的 dist 混入结果。

源库先写入账本、raw 水位/拒绝、epoch、Memory修订/发布、待处理队列、unknown行动及原生工具输出，并用完整合成旧配置核对 Lifecycle 的 false/120000、观察设置及第二次迁移文件幂等。六个TTS历史契约来自当前插件静态声明，不实例化供应商。真实 `pg_dump`/`pg_dumpall` 与 `pg_restore` 在不同system identifier的集群间恢复，逐表、sequence及schema对比后执行 inspect→apply→verify→apply→verify。

升级后再加入图片和WAV字节、授权来源、冻结输入、新事实、新修订、第二个unknown行动及工具产物，并再次完整备份恢复。兼容回退演练执行固定 `50f01850` 的原始基础schema验证函数和只读存储核对，证明这些新增事实可保留；这不代表旧Runtime、旧插件或生产重启已经验收。`rollback-check` 对最新恢复点通过，对旧恢复点和被改动的当前工具产物拒绝。兼容回执明确记录 `runtime_restart_approved=false`，正式重启仍须单独审查。

`drill-result.json`、`rollback-result.json`、两次快照、dump及容器身份为实际验收证据。失败的命令日志留在私有目录供定位，失败运行不会写成功结果。这个容器演练覆盖真实PG恢复与离线API，不替代生产systemd/cgroup或管理员安装步骤。
