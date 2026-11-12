#!/usr/bin/env python3
"""功能：持有数据库级部署锁后启动一个前台 Runtime，阻止第二个受控实例和离线迁移。
main 读取 recovery.py 的受限 plan，按已核验身份取得 3041107 session advisory lock，
随后执行 -- 后的管理员审查 argv。监视 PostgreSQL 连接，失联即清理专属systemd控制组。
关系：systemd 应将本文件作为唯一 ExecStart wrapper；同锁用于 offline-upgrade apply。
本文件不启停 systemd、PostgreSQL 或 NapCat，不清空队列，不把外部 unknown 当失败重发。
输入/副作用：显式 Runtime 命令产生真实业务效果；仅在 main SHA、迁移/恢复/CI及管理员
接管验收后执行。未使用该 wrapper 的旧进程由管理员先停写、排空、停服务并禁用自动拉起。
"""
import argparse
import importlib.util
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import time
import threading

spec = importlib.util.spec_from_file_location("deployment_recovery", Path(__file__).with_name("recovery.py"))
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


def service_cgroup(plan):
    lines = Path("/proc/self/cgroup").read_text().splitlines()
    paths = [line[3:] for line in lines if line.startswith("0::")]
    recovery.require(len(paths) == 1 and Path(paths[0]).name == plan["application_unit"], "dedicated_systemd_cgroup_required")
    root = Path("/sys/fs/cgroup")
    group = (root / paths[0].lstrip("/")).resolve(strict=True)
    recovery.require(group.is_relative_to(root) and (group / "cgroup.procs").is_file(), "dedicated_systemd_cgroup_required")
    return group


def members(group, excluded):
    result = set()
    for file in [group / "cgroup.procs", *group.rglob("cgroup.procs")]:
        try:
            result.update(int(value) for value in file.read_text().split())
        except FileNotFoundError:
            continue
    return result - excluded


def terminate(child, group, connection_pid):
    # MCP会setsid；用整个专属cgroup覆盖其后代，保持wrapper/持锁psql存活直到清理完成。
    excluded = {os.getpid(), connection_pid}
    for sig, budget in ((signal.SIGTERM, 15), (signal.SIGKILL, 5)):
        deadline = time.monotonic() + budget
        while members(group, excluded) and time.monotonic() < deadline:
            for pid in members(group, excluded):
                try:
                    os.kill(pid, sig)
                except ProcessLookupError:
                    pass
            child.poll()
            threading.Event().wait(0.05)
        if not members(group, excluded):
            child.wait(timeout=1)
            return
    # 无法清理时持续持锁等管理员处理，不允许新Runtime与未知旧副作用并行。
    print("runtime_cgroup_not_drained; ownership retained", file=sys.stderr, flush=True)
    while members(group, excluded):
        for pid in members(group, excluded):
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        child.poll()
        threading.Event().wait(1)
    child.wait(timeout=1)


def run(plan, argv):
    recovery.require(argv and Path(argv[0]).is_absolute(), "absolute_runtime_command_required")
    # release receipt 由集成验收产生，wrapper 核验内容 hash 与启动目录实际 Git SHA。
    release_path = recovery.private_file(plan["release_receipt"])
    recovery.require(recovery.digest(release_path) == plan["release_receipt_sha256"], "release_receipt_mismatch")
    release = recovery.read_json(release_path)
    candidate = subprocess.run(["git", "-C", plan["release_root"], "rev-parse", "HEAD"],
                               capture_output=True, text=True, timeout=10, check=False)
    recovery.require(candidate.returncode == 0 and candidate.stdout.strip() == release.get("accepted_main_sha")
                     and release.get("migration_verified") is True and release.get("required_ci_passed") is True
                     and release.get("administrator_takeover_approved") is True, "release_not_accepted")
    recovery.require(release.get("runtime_argv") == argv and release.get("database_identity") == plan["source"]["identity"],
                     "release_command_or_database_mismatch")
    for entry in release["runtime_files"]:
        path = (Path(plan["release_root"]) / entry["path"]).resolve(strict=True)
        recovery.require(path.is_relative_to(Path(plan["release_root"]).resolve()) and
                         recovery.digest(path) == entry["sha256"], "release_artifact_changed")
    recovery.require(len(release["runtime_files"]) > 0, "release_files_required")
    group = service_cgroup(plan)
    pg = recovery.source(plan)
    child = None
    handlers = {}
    try:
        with pg.lease(plan["source"]["identity"]) as connection:
            pg.idle()
            try:
                child = subprocess.Popen(argv, cwd=plan["release_root"], start_new_session=True)
                stopping = False
                def forward(signum, _frame):
                    nonlocal stopping
                    stopping = True
                    if child.poll() is None:
                        os.killpg(child.pid, signum)
                for sig in (signal.SIGTERM, signal.SIGINT):
                    handlers[sig] = signal.signal(sig, forward)
                while child.poll() is None and not stopping:
                    readable, _, _ = select.select([connection.stdout], [], [], 0.5)
                    recovery.require(connection.poll() is None and not readable, "ownership_connection_lost")
                    pg.heartbeat()
                return child.returncode if child.returncode is not None else 128 + signal.SIGTERM
            finally:
                if child is not None:
                    terminate(child, group, connection.pid)
    finally:
        for sig, handler in handlers.items():
            signal.signal(sig, handler)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", required=True)
    parser.add_argument("runtime", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    argv = args.runtime[1:] if args.runtime[:1] == ["--"] else args.runtime
    return run(recovery.read_json(args.plan), argv)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (recovery.Refusal, OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
        print("single_owner_refused", file=sys.stderr)
        sys.exit(1)
