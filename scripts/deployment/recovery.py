#!/usr/bin/env python3
"""功能：为 #304 提供 PostgreSQL17 停写备份、独立 scratch 恢复及兼容回退核对。
主要入口：backup 保存全库/全局角色、配置及全部显式资产根；restore 仅创建新 scratch；
verify 校验备份字节；compare 用原列投影检查升级没有改动旧事实；rollback-check 对升级后
最新快照作同样核对，且必须有针对当前 schema 的旧代码兼容验收回执。
check_rollback 持同一部署锁核对回执绑定、数据库身份、旧/新增事实、结构和当前资产；
返回 preserved 只表示冻结检查点保留，实际候选兼容行为仍由回执对应的 scratch 验收证明。
关系：离线 TypeScript 入口负责增量 DDL/Kind/Lifecycle，本文件不导入 Runtime、不恢复
生产库、不执行模型/发送、不启停应用或 NapCat。pg_ctl 只用于本次新建 scratch 目录。
输入是 0600 JSON plan 及 libpq service 文件。输出只有哈希、计数及稳定错误码；子进程
stderr 不打印，避免 SQL/连接信息泄露。文件和表内容只用于本机流式指纹/私有副本。
"""
import argparse
import contextlib
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import select
import stat
import subprocess
import sys
import uuid
from urllib.parse import quote


class Refusal(RuntimeError):
    pass


def require(ok, code):
    if not ok:
        raise Refusal(code)


def private_file(path):
    p = Path(path)
    s = p.lstat()
    require(stat.S_ISREG(s.st_mode) and s.st_uid == os.getuid()
            and stat.S_IMODE(s.st_mode) == 0o600, "private_file_required")
    return p


def read_json(path):
    return json.loads(private_file(path).read_text())


def write_json(path, value):
    with open(path, "x", encoding="utf8") as stream:
        os.chmod(path, 0o600)
        json.dump(value, stream, sort_keys=True, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def ident(value):
    return '"' + value.replace('"', '""') + '"'


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def clean_env():
    return {k: v for k, v in os.environ.items() if not k.startswith("PG")}


class Postgres:
    def __init__(self, bin_dir, env):
        self.lease_pid = None
        self.lease_process = None
        self.bin = Path(bin_dir).resolve(strict=True)
        require(self.bin.is_dir(), "pg_bin_required")
        self.env = {**clean_env(), **env, "PGCONNECT_TIMEOUT": "10",
                    "PGAPPNAME": "kaguya-offline-recovery",
                    "PGOPTIONS": "-c timezone=UTC -c statement_timeout=300000 -c lock_timeout=10000"}
        require(re.search(r"\b17\.", self.run("psql", "--version").decode()), "pg17_tools_required")

    def run(self, program, *args, output=None):
        # 失败不回显参数或 stderr；敏感 globals/dump 直接写入私有文件。
        try:
            result = subprocess.run([str(self.bin / program), *map(str, args)],
                                    env=self.env, stdout=output or subprocess.PIPE,
                                    stderr=subprocess.PIPE, timeout=600, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise Refusal("pg_command_unavailable") from None
        require(result.returncode == 0, "pg_command_failed_" + program)
        return result.stdout

    def sql(self, sql):
        return self.run("psql", "-X", "-w", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", sql).decode().strip()

    def identity(self):
        value = json.loads(self.sql("SELECT json_build_object('system_identifier',system_identifier::text,"
            "'database',current_database(),'data_directory',current_setting('data_directory'),"
            "'socket_directory',current_setting('unix_socket_directories'),"
            "'port',current_setting('port'),'version',current_setting('server_version_num')) FROM pg_control_system()"))
        require(int(value.pop("version")) // 10000 == 17, "pg17_server_required")
        return value

    def guard(self, expected):
        if self.lease_process is not None:
            self.heartbeat()
        require(self.identity() == expected, "database_identity_mismatch")

    def heartbeat(self):
        proc = self.lease_process
        require(proc is not None and proc.poll() is None, "ownership_connection_lost")
        try:
            proc.stdin.write(b"SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=3041107 AND objsubid=1 AND pid=pg_backend_pid() AND granted) THEN pg_backend_pid() ELSE 0 END;\n")
            proc.stdin.flush()
            require(select.select([proc.stdout], [], [], 2)[0], "ownership_heartbeat_timeout")
            require(proc.stdout.readline().strip() == str(self.lease_pid).encode(), "ownership_connection_lost")
        except OSError:
            raise Refusal("ownership_connection_lost") from None

    @contextlib.contextmanager
    def lease(self, expected):
        # 与 offline-upgrade.ts 使用同一锁。单实例 wrapper 必须一直持有此连接。
        self.guard(expected)
        proc = subprocess.Popen([str(self.bin / "psql"), "-X", "-w", "-qAt", "-v", "ON_ERROR_STOP=1"],
                                env=self.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL)
        self.lease_process = proc
        try:
            conditions = ["system_identifier::text=" + literal(expected["system_identifier"]),
                          "current_database()=" + literal(expected["database"]),
                          "current_setting('data_directory')=" + literal(expected["data_directory"])]
            sql = "SELECT CASE WHEN " + " AND ".join(conditions) +                 " THEN CASE WHEN pg_try_advisory_lock(3041107) THEN pg_backend_pid() ELSE 0 END ELSE 0 END FROM pg_control_system();\n"
            proc.stdin.write(sql.encode())
            proc.stdin.flush()
            require(select.select([proc.stdout], [], [], 15)[0], "ownership_timeout")
            value = proc.stdout.readline().strip()
            require(value.isdigit() and int(value) > 0, "ownership_unavailable")
            self.lease_pid = int(value)
            yield proc
            require(proc.poll() is None, "ownership_connection_lost")
        finally:
            self.lease_pid = None
            self.lease_process = None
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
            proc.stdin.close()
            proc.stdout.close()

    def idle(self):
        require(self.sql("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() "
                         "AND pid<>pg_backend_pid() AND backend_type='client backend' AND pid<>" + str(self.lease_pid or 0)) == "0", "database_clients_present")
        require(self.sql("SELECT count(*) FROM pg_prepared_xacts WHERE database=current_database()") == "0", "prepared_transactions_present")

    def schema_fingerprint(self, schema):
        scope = literal(schema)
        sql = "SELECT value FROM (SELECT jsonb_build_array('column',table_name,column_name,udt_name,is_nullable,column_default)::text value FROM information_schema.columns WHERE table_schema=" + scope +               " UNION ALL SELECT jsonb_build_array('index',tablename,indexname,indexdef)::text FROM pg_indexes WHERE schemaname=" + scope +               " UNION ALL SELECT jsonb_build_array('constraint',r.relname,c.conname,pg_get_constraintdef(c.oid,true),c.convalidated)::text FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname=" + scope +               ') q ORDER BY value COLLATE "C"'
        return self.fingerprint(sql)

    def migration_projection(self, schema, snapshot):
        table = "information_observation_progress"
        columns = snapshot["columns"].get(table, [])
        if not any(c in columns for c in ("allocated_through", "discovered_through")):
            return {}
        expressions = []
        for column in columns:
            value = "p." + ident(column)
            if column in ("allocated_through", "discovered_through"):
                value = "GREATEST(" + value + ",p.through_position,COALESCE((SELECT max(o.through_position) FROM " + ident(schema) + ".information_observations o WHERE o.stream_id=p.stream_id),0))"
            expressions.append(value)
        expr = "jsonb_build_array(" + ",".join(expressions) + ")::text"
        return {table: self.fingerprint("SELECT " + expr + " FROM " + ident(schema) + "." + ident(table) +
                                       ' p ORDER BY (' + expr + ') COLLATE "C"')}

    def fingerprint(self, sql):
        # COPY 按 C 排序，保留重复行。原列投影允许迁移添加列，但不能改变旧值。
        proc = subprocess.Popen([str(self.bin / "psql"), "-X", "-w", "-qAt", "-v", "ON_ERROR_STOP=1",
                                 "-c", "COPY (" + sql + ") TO STDOUT"], env=self.env,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        h = hashlib.sha256()
        count = 0
        try:
            for line in proc.stdout:
                h.update(line)
                count += 1
            require(proc.wait(timeout=10) == 0, "snapshot_query_failed")
        finally:
            proc.stdout.close()
            if proc.poll() is None:
                proc.kill()
                proc.wait()
        return {"rows": count, "sha256": h.hexdigest()}

    def snapshot(self, schema, projection=None):
        if projection is None:
            tables = json.loads(self.sql("SELECT coalesce(json_object_agg(table_name,cols),'{}') FROM "
                "(SELECT table_name,json_agg(column_name ORDER BY ordinal_position) cols "
                "FROM information_schema.columns WHERE table_schema=" + literal(schema) +
                " AND table_name IN (SELECT tablename FROM pg_tables WHERE schemaname=" + literal(schema) +
                ") GROUP BY table_name) q"))
            seqs = json.loads(self.sql("SELECT coalesce(json_agg(sequencename ORDER BY sequencename),'[]') "
                                      "FROM pg_sequences WHERE schemaname=" + literal(schema)))
        else:
            tables, seqs = projection["columns"], list(projection["sequences"])
        result = {"columns": tables, "tables": {}, "sequences": {}}
        for table, columns in sorted(tables.items()):
            expr = "jsonb_build_array(" + ",".join(map(ident, columns)) + ")::text"
            result["tables"][table] = self.fingerprint("SELECT " + expr + " FROM " + ident(schema) + "." + ident(table) +
                                                       " ORDER BY (" + expr + ") COLLATE \"C\"")
        for seq in seqs:
            result["sequences"][seq] = self.sql("SELECT last_value::text||':'||is_called::text FROM " + ident(schema) + "." + ident(seq))
        return result


def source(plan):
    service = plan["source"]["service"]
    require(re.fullmatch(r"[A-Za-z0-9_-]+", service), "invalid_service_name")
    env = {"PGSERVICEFILE": str(private_file(plan["service_file"])), "PGSERVICE": service}
    if plan.get("pass_file"):
        env["PGPASSFILE"] = str(private_file(plan["pass_file"]))
    pg = Postgres(plan["pg_bin"], env)
    pg.guard(plan["source"]["identity"])
    return pg


def stopped(plan):
    unit = plan["application_unit"]
    require(re.fullmatch(r"kaguya(?:[-.][a-zA-Z0-9_-]+)*\.service", unit), "invalid_application_unit")
    command = ["systemctl"] + (["--user"] if plan["systemd_scope"] == "user" else [])
    require(plan["systemd_scope"] in ("user", "system"), "invalid_systemd_scope")
    result = subprocess.run(command + ["show", unit, "--property=LoadState,ActiveState,SubState,MainPID"],
                            capture_output=True, text=True, timeout=10, check=False)
    fields = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    require(result.returncode == 0 and fields.get("LoadState") == "loaded" and
            fields.get("ActiveState") in ("inactive", "failed") and fields.get("MainPID") == "0",
            "application_not_stopped")


def tree_files(root):
    root = Path(root)
    require(root.is_dir() and not root.is_symlink(), "asset_root_required")
    entries = {}
    for p in [root, *sorted(root.rglob("*"))]:
        s = p.lstat()
        require(stat.S_ISREG(s.st_mode) or stat.S_ISDIR(s.st_mode), "asset_symlink_or_special_file")
        entry = {"mode": stat.S_IMODE(s.st_mode), "uid": s.st_uid, "gid": s.st_gid,
                 "type": "file" if p.is_file() else "directory"}
        if p.is_file():
            entry["sha256"] = digest(p)
        entries[str(p.relative_to(root))] = entry
    return entries


def backup(plan, output):
    stopped(plan)
    pg = source(plan)
    with pg.lease(plan["source"]["identity"]):
        return backup_locked(plan, output, pg)


def backup_locked(plan, output, pg, check_stopped=stopped):
    pg.idle()
    require(pg.sql("SELECT count(*) FROM pg_tablespace WHERE spcname NOT IN ('pg_default','pg_global')") == "0",
            "tablespace_requires_separate_review")
    roots = plan["asset_roots"]
    require("config" in roots and "media" in roots and "tools" in roots, "explicit_config_media_tools_required")
    output = Path(output).resolve()
    for root in roots.values():
        r = Path(root).resolve(strict=True)
        require(output != r and not output.is_relative_to(r) and not r.is_relative_to(output), "overlapping_backup_path")
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    before = pg.snapshot(plan.get("schema", "public"))
    migration_projection = pg.migration_projection(plan.get("schema", "public"), before)
    pg.guard(plan["source"]["identity"])
    pg.run("pg_dump", "-w", "--format=custom", "--file=" + str(output / "database.dump"))
    pg.guard(plan["source"]["identity"])
    with open(output / "globals.sql", "xb") as stream:
        pg.run("pg_dumpall", "-w", "--globals-only", output=stream)
    assets = {}
    for name, root in roots.items():
        require(re.fullmatch(r"[a-z][a-z0-9_-]*", name), "invalid_asset_label")
        entries = tree_files(root)
        shutil.copytree(root, output / name)
        require(tree_files(output / name) == entries == tree_files(root), "asset_changed_during_backup")
        assets[name] = entries
    check_stopped(plan)
    pg.guard(plan["source"]["identity"])
    pg.idle()
    require(pg.snapshot(plan.get("schema", "public"), before) == before, "database_changed_during_backup")
    for name in ("database.dump", "globals.sql"):
        (output / name).chmod(0o600)
    receipt = {"version": 1, "source": plan["source"]["identity"], "schema": plan.get("schema", "public"),
               "snapshot": before, "schemaCatalog": pg.schema_fingerprint(plan.get("schema", "public")),
               "assets": assets, "migrationExpectedTables": migration_projection,
               "systemIdentifier": plan["source"]["identity"]["system_identifier"],
               "database": plan["source"]["identity"]["database"],
               "dataDirectory": plan["source"]["identity"]["data_directory"],
               "configRoot": str(Path(roots["config"]).resolve()), "serviceStopped": True,
               "capturedAt": datetime.now(timezone.utc).isoformat(),
               "files": {n: digest(output / n) for n in ("database.dump", "globals.sql")}}
    write_json(output / "receipt.json", receipt)
    return {"backup_receipt_sha256": digest(output / "receipt.json")}


def verify_backup(root, expected_hash):
    root = Path(root)
    require(digest(private_file(root / "receipt.json")) == expected_hash, "backup_receipt_mismatch")
    receipt = read_json(root / "receipt.json")
    require(set(receipt["files"]) == {"database.dump", "globals.sql"}, "invalid_backup_files")
    for name, expected in receipt["files"].items():
        require(digest(private_file(root / name)) == expected, "backup_file_changed")
    for name, expected in receipt["assets"].items():
        require(re.fullmatch(r"[a-z][a-z0-9_-]*", name), "invalid_asset_label")
        require(tree_files(root / name) == expected, "backup_asset_changed")
    return receipt


def compare(pg, receipt, allow_kind_update=False):
    current = pg.snapshot(receipt["schema"], receipt["snapshot"])
    baseline = receipt["snapshot"]
    for name, expected in baseline["tables"].items():
        if allow_kind_update and name == "information_kinds":
            continue  # 完整 Kind 合约和历史 Kind 保留由离线 TS 验证器负责。
        if allow_kind_update:
            expected = receipt.get("migrationExpectedTables", {}).get(name, expected)
        require(current["tables"][name] == expected, "preserved_table_changed_" + name)
    require(current["sequences"] == baseline["sequences"], "preserved_sequence_changed")
    return current


def check_rollback(plan, pg, receipt, receipt_hash, compat):
    """核对升级后最新恢复点；调用方先验证备份字节与停止状态，本函数不启动候选程序。"""
    require(isinstance(compat, dict) and
            compat.get("backup_receipt_sha256") == receipt_hash and
            isinstance(plan.get("rollback_sha"), str) and
            re.fullmatch(r"[0-9a-f]{40}", plan["rollback_sha"]) and
            compat.get("candidate_sha") == plan["rollback_sha"] and
            compat.get("verified_on_scratch") is True and
            compat.get("pending_unknown_reconciled") is True, "rollback_compatibility_required")
    roots = plan.get("asset_roots", {})
    expected_assets = receipt.get("assets", {})
    require(isinstance(roots, dict) and isinstance(expected_assets, dict) and
            {"config", "media", "tools"} <= set(expected_assets) and
            set(roots) == set(expected_assets), "rollback_asset_roots_mismatch")
    expected_identity = plan["source"]["identity"]
    with pg.lease(expected_identity):
        pg.guard(expected_identity)
        pg.idle()
        # 回退保留升级后的全部事实，因此不能使用迁移阶段的 Kind/水位例外。
        current = compare(pg, receipt)
        require(pg.schema_fingerprint(receipt["schema"]) == receipt["schemaCatalog"],
                "rollback_schema_changed")
        for name, root in roots.items():
            require(tree_files(root) == expected_assets[name], "rollback_asset_changed_" + name)
        # 最后再次确认仍持锁且无第二个客户端，避免返回已失去停写边界的成功。
        pg.guard(expected_identity)
        pg.idle()
        return {"preserved": True, "tables": len(current["tables"]), "runtime_started": False}


def restore(plan, backup_root, receipt_hash, scratch, globals_hash):
    receipt = verify_backup(backup_root, receipt_hash)
    require(plan.get("configuration_review", {}).get("pluginNames"), "configuration_review_required")
    require(receipt["files"]["globals.sql"] == globals_hash, "globals_review_hash_required")
    require(receipt["source"]["database"] not in ("postgres", "template0", "template1"), "reserved_database_name")
    scratch = Path(scratch).absolute()
    # pg_ctl 的 -o 使用 shell-like 拆分；路径严格收窄，绝不插入任意 shell 文本。
    require(re.fullmatch(r"/[A-Za-z0-9_./-]+", str(scratch)) and len(str(scratch / "socket")) < 90,
            "scratch_path_invalid")
    require(not scratch.exists() and not scratch.is_symlink(), "scratch_must_be_new")
    protected = [receipt["source"]["data_directory"], backup_root, *plan.get("asset_roots", {}).values()]
    if plan.get("release_root"):
        protected.append(plan["release_root"])
    for path in protected:
        protected_path = Path(path).resolve()
        require(not scratch.resolve().is_relative_to(protected_path) and
                not protected_path.is_relative_to(scratch.resolve()), "scratch_overlaps_source")
    scratch.mkdir(mode=0o700)
    data, socket = scratch / "data", scratch / "socket"
    socket.mkdir(mode=0o700)
    user = "scratch_" + uuid.uuid4().hex
    pg = Postgres(plan["pg_bin"], {"PGHOST": str(socket), "PGPORT": "55439", "PGUSER": user, "PGDATABASE": "postgres"})
    pg.run("initdb", "-D", data, "-U", user, "--encoding=UTF8", "--locale=C.UTF-8", "--auth-local=trust", "--auth-host=reject")
    attempted_start = False
    try:
        attempted_start = True
        pg.run("pg_ctl", "-D", data, "-l", scratch / "postgres.log", "-w", "-t", "30", "-o",
               "-c listen_addresses='' -c unix_socket_directories=" + str(socket) + " -p 55439", "start")
        expected = pg.identity()
        require(expected["system_identifier"] != receipt["source"]["system_identifier"] and
                Path(expected["data_directory"]).resolve() == data.resolve() and
                Path(expected["socket_directory"]).resolve() == socket.resolve(), "scratch_identity_mismatch")
        pg.guard(expected)
        pg.run("psql", "-X", "-w", "-v", "ON_ERROR_STOP=1", "--file=" + str(Path(backup_root) / "globals.sql"))
        pg.guard(expected)
        pg.run("pg_restore", "-w", "--exit-on-error", "--create", "--dbname=postgres", str(Path(backup_root) / "database.dump"))
        pg.env["PGDATABASE"] = receipt["source"]["database"]
        expected = {**expected, "database": receipt["source"]["database"]}
        pg.guard(expected)
        compare(pg, receipt)
        require(pg.schema_fingerprint(receipt["schema"]) == receipt["schemaCatalog"], "restored_schema_changed")
        for name in receipt["assets"]:
            shutil.copytree(Path(backup_root) / name, scratch / name)
        service_file = scratch / "pg_service.conf"
        service_file.write_text("[scratch]\nhost=" + str(socket) + "\nport=55439\nuser=" + user +
                                "\ndbname=" + expected["database"] + "\n")
        service_file.chmod(0o600)
        scratch_plan = {**plan, "service_file": str(service_file),
                        "source": {"service": "scratch", "identity": expected},
                        "asset_roots": {name: str(scratch / name) for name in receipt["assets"]}}
        scratch_plan.pop("pass_file", None)
        write_json(scratch / "recovery-plan.json", scratch_plan)
        # 恢复后重新备份，独立绑定 scratch 身份；生产回执不充当 scratch 写入许可。
        with pg.lease(expected):
            backup_locked(scratch_plan, scratch / "migration-backup", pg, lambda _: pg.idle())
        stopped_receipt = {"systemIdentifier": expected["system_identifier"], "database": expected["database"],
                           "dataDirectory": expected["data_directory"], "configRoot": str(scratch / "config"),
                           "serviceStopped": True, "capturedAt": datetime.now(timezone.utc).isoformat()}
        write_json(scratch / "stopped-receipt.json", stopped_receipt)
        cordis_hash = digest(scratch / "config" / "cordis.yml")
        require(cordis_hash == plan["configuration_review"]["cordisSha256"], "configuration_review_stale")
        write_json(scratch / "offline-target.json", {
            "connectionString": "postgresql://" + user + "@/" + quote(expected["database"], safe="") + "?host=" + quote(str(socket), safe="") + "&port=55439",
            "expectedSystemIdentifier": expected["system_identifier"], "expectedDatabase": expected["database"],
            "expectedDataDirectory": expected["data_directory"], "configRoot": str(scratch / "config"),
            "firstPartyOnly": True, "configurationReview": plan["configuration_review"],
            "backupReceipt": {"path": str(scratch / "migration-backup" / "receipt.json"), "sha256": digest(scratch / "migration-backup" / "receipt.json")},
            "stoppedReceipt": {"path": str(scratch / "stopped-receipt.json"), "sha256": digest(scratch / "stopped-receipt.json")},
        })
        write_json(scratch / "restore-receipt.json", {"version": 1, "identity": expected,
                   "backup_receipt_sha256": receipt_hash, "preserved": True,
                   "scratch_user": user, "runtime_started": False})
        return {"restored": True, "restore_receipt_sha256": digest(scratch / "restore-receipt.json")}
    finally:
        if attempted_start:
            # start 超时也要尝试清理本次新目录；保留原始失败，管理员可从私有日志核对。
            original_error = sys.exc_info()[0] is not None
            try:
                pg.run("pg_ctl", "-D", data, "-w", "-t", "30", "-m", "fast", "stop")
            except Refusal:
                if not original_error:
                    raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("backup", "verify", "restore", "compare", "rollback-check", "stopped-receipt"))
    parser.add_argument("--plan", required=True)
    parser.add_argument("--directory", required=True)
    parser.add_argument("--receipt-sha256")
    parser.add_argument("--scratch")
    parser.add_argument("--reviewed-globals-sha256")
    parser.add_argument("--compatibility-receipt")
    args = parser.parse_args()
    plan = read_json(args.plan)
    require(plan.get("version") == 1, "invalid_plan_version")
    if args.command == "stopped-receipt":
        stopped(plan)
        pg = source(plan)
        with pg.lease(plan["source"]["identity"]):
            pg.idle()
            expected = plan["source"]["identity"]
            write_json(args.directory, {"systemIdentifier": expected["system_identifier"],
                       "database": expected["database"], "dataDirectory": expected["data_directory"],
                       "configRoot": str(Path(plan["asset_roots"]["config"]).resolve()),
                       "serviceStopped": True, "capturedAt": datetime.now(timezone.utc).isoformat()})
            result = {"stopped_receipt_sha256": digest(args.directory)}
    elif args.command == "backup":
        result = backup(plan, args.directory)
    elif args.command == "restore":
        require(args.scratch and args.reviewed_globals_sha256, "scratch_review_required")
        result = restore(plan, args.directory, args.receipt_sha256, args.scratch, args.reviewed_globals_sha256)
    else:
        receipt = verify_backup(args.directory, args.receipt_sha256)
        if args.command == "verify":
            result = {"verified": True}
        else:
            stopped(plan)
            pg = source(plan)
            if args.command == "rollback-check":
                compat = read_json(args.compatibility_receipt)
                result = check_rollback(plan, pg, receipt, args.receipt_sha256, compat)
            else:
                with pg.lease(plan["source"]["identity"]):
                    pg.guard(plan["source"]["identity"])
                    pg.idle()
                    current = compare(pg, receipt, allow_kind_update=True)
                    pg.guard(plan["source"]["identity"])
                    pg.idle()
                    result = {"preserved": True, "tables": len(current["tables"]), "runtime_started": False}
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    os.umask(0o077)
    try:
        main()
    except (Refusal, OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({"error": str(error) if isinstance(error, Refusal) else "invalid_input_or_io"}), file=sys.stderr)
        sys.exit(1)
