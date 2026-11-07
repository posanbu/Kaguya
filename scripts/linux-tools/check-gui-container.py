#!/usr/bin/env python3
"""功能概述：rootless Linux 的首阶段双 UID GUI 实测，不调用模型或连接用户桌面。
主要职责：固定 OCI 隔离参数启动可信显示，再由宿主固定 UID 启动 app-session 与合成 GTK。
until/until_json 共享剩余预算；published_identity 验证就绪记录，application_identity 核实实际进程。
代码库关系：Linux tools workflow 构建 Dockerfile.gui 后调用；证据绑定输入镜像 digest。
输入输出与副作用：仅临时命名容器与 HOME，finally 清理；诊断失败也继续资源清理，原始异常与清理失败合并保留。
"""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import traceback
import uuid
from gui_fixture_wait import wait_for_command

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "linux-environments"))
from broker import chromium_profile

parser = argparse.ArgumentParser()
parser.add_argument("--archive", required=True)
parser.add_argument("--digest", required=True)
args = parser.parse_args()
name = "kaguya-gui-ci-" + uuid.uuid4().hex
probe_process = None
podman_unresponsive = False


def host_diagnostics(reason):
    """不依赖容器 exec/Podman 锁的宿主证据；不读取进程环境或应用内容。"""
    evidence = {"reason": reason, "processes": [], "storage": {}}
    for process in Path("/proc").iterdir():
        if not process.name.isdigit():
            continue
        try:
            comm = (process / "comm").read_text().strip()
            if comm not in ("podman", "conmon", "crun", "runc", "fuse-overlayfs"):
                continue
            item = {"pid": int(process.name), "comm": comm}
            for field in ("status", "wchan", "cgroup", "stack"):
                try:
                    item[field] = (process / field).read_text()[:8192]
                except OSError as error:
                    item[field] = str(error)
            evidence["processes"].append(item)
        except OSError:
            continue
    for directory in (Path.home() / ".local/share/containers/storage", Path(f"/run/user/{os.getuid()}/containers")):
        try:
            stats = os.statvfs(directory)
            evidence["storage"][str(directory)] = {
                "availableBytes": stats.f_bavail * stats.f_frsize, "availableInodes": stats.f_favail,
                "entries": sorted(entry.name for entry in directory.iterdir())[:100],
            }
        except OSError as error:
            evidence["storage"][str(directory)] = str(error)
    with Path("gui-host-diagnostics.jsonl").open("a") as output:
        output.write(json.dumps(evidence) + "\n")


def command(*parts, timeout=30, check=True, input=None):
    global podman_unresponsive
    try:
        result = subprocess.run(["/usr/bin/podman", *parts], input=input, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    except subprocess.TimeoutExpired:
        podman_unresponsive = True
        host_diagnostics(f"podman {parts[0]} exceeded {timeout}s")
        raise
    if check and result.returncode:
        if result.stdout:
            print(result.stdout[-65536:].decode(errors="replace"), flush=True)
        raise RuntimeError(result.stderr.decode(errors="replace"))
    return result


def until(parts, seconds=15):
    return wait_for_command(command, parts, seconds=seconds)


def until_json(parts, predicate, seconds=15):
    return wait_for_command(command, parts, seconds=seconds, predicate=predicate)


def published_identity(value, uid=None):
    return (isinstance(value, dict) and isinstance(value.get("pid"), int) and value["pid"] > 1
            and (uid is None or value.get("uid") == uid))


def application_identity(pid):
    status = command("exec", name, "/bin/cat", f"/proc/{pid}/status").stdout.decode()
    assert re.search(r"^Uid:\s+1001\s+1001\s+1001\s+1001$", status, re.M), status
    assert not re.search(r"^State:\s+Z", status, re.M), status
    process = command("exec", name, "/bin/cat", f"/proc/{pid}/stat").stdout.decode()
    return {"pid": pid, "uid": 1001, "startTime": process.rsplit(")", 1)[1].split()[19]}


info = json.loads(command("info", "--format=json").stdout)
assert info["host"]["security"]["rootless"] is True
security = info["host"]["security"]
assert security["seccompEnabled"] is True
default_profile = Path(security["seccompProfilePath"])
assert not default_profile.is_symlink()
selected_profile = chromium_profile(info["version"]["Version"], hashlib.sha256(default_profile.read_bytes()).hexdigest())
command("load", "--input", str(Path(args.archive).resolve()), timeout=300)
image = "localhost/kaguya-gui@" + args.digest
assert json.loads(command("image", "inspect", image).stdout)[0]["Digest"] == args.digest
try:
    command("run", "--detach", "--pull=never", "--name", name,
            "--userns=keep-id:uid=1000,gid=1000", "--user=1000:1000", "--cap-drop=ALL",
            "--security-opt=no-new-privileges", "--read-only", "--network=none",
            "--security-opt=seccomp=" + str(selected_profile),
            "--ipc=private", "--pid=private", "--cgroupns=private", "--cpus=1", "--memory=2g",
            "--memory-swap=2g", "--pids-limit=384", "--shm-size=512m", "--init",
            "--tmpfs=/tmp:rw,nosuid,nodev,size=512m", "--tmpfs=/run:rw,nosuid,nodev,size=64m",
            "--tmpfs=/run/kaguya-app:rw,nosuid,nodev,size=32m,mode=1777",
            "--tmpfs=/home/app:rw,nosuid,nodev,size=256m,mode=1777",
            "--tmpfs=/home/tool:rw,nosuid,nodev,size=256m,mode=0700,U",
            "--env=KAGUYA_ENVIRONMENT_ID=" + name, "--env=KAGUYA_ENVIRONMENT_GENERATION=0",
            "--env=KAGUYA_HELPER_PROTOCOL_VERSION=1", image)
    container = json.loads(command("inspect", name).stdout)[0]
    oci = json.loads(command("unshare", "/bin/cat", container["OCIConfigPath"]).stdout)
    assert oci["process"]["user"]["uid"] == 1000
    assert oci["process"]["noNewPrivileges"] is True
    assert all(not caps for caps in oci["process"]["capabilities"].values())
    assert oci["root"]["readonly"] is True
    assert oci["linux"]["seccomp"]["defaultAction"] == "SCMP_ACT_ERRNO"
    command("exec", "--detach", "--user=1001:1001", "--env=KAGUYA_GUI_ACCEPTANCE=1", name, "/usr/bin/python3", "/opt/kaguya-tools/gui-app-session.py")
    address_result = until(["exec", name, "/usr/bin/dbus-send", "--session", "--print-reply", "--dest=org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus.GetAddress"])
    address = re.search(r'string "([^"]+)"', address_result.decode()).group(1)
    assert address.startswith("unix:path=/run/kaguya-app/session/at-spi/")
    command("exec", name, "/usr/bin/dbus-send", "--bus=" + address, "--print-reply", "--dest=org.freedesktop.DBus", "/", "org.freedesktop.DBus.ListNames")
    print(json.dumps({"controlUid": 1000, "appUid": 1001, "atspiAddress": address, "bothBusesConnected": True}), flush=True)
    command("exec", "--detach", "--user=1001:1001", "--env=HOME=/home/app/session", "--env=GTK_MODULES=gail:atk-bridge", "--env=NO_AT_BRIDGE=0", name, "/usr/bin/python3", "/opt/kaguya-tools/gui-fixture.py")
    ledger = until_json(["exec", "--user=1001:1001", name, "/bin/cat", "/home/app/session/gui-ledger.json"], lambda value: published_identity(value, 1001))
    assert ledger["uid"] == 1001
    gtk_identity = application_identity(ledger["pid"])
    probe_process = subprocess.Popen(["/usr/bin/podman", "exec", name, "/usr/local/bin/node", "/opt/kaguya-tools/gui-probe.mjs", str(ledger["pid"])], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    driver = until_json(["exec", name, "/bin/cat", "/home/tool/gui-probe-driver.json"], published_identity)
    health = json.loads(command("exec", "-i", name, "/opt/kaguya-tools/helper", input=b'{"helperProtocolVersion":1,"kind":"health"}').stdout)
    assert health["ready"] is True and health["generation"] == 0 and health["serviceInstanceId"]
    print(json.dumps({"controlHealth": health}), flush=True)
    isolation = command("exec", "--user=1001:1001", name, "/usr/bin/python3", "/opt/kaguya-tools/gui-isolation-probe.py", str(driver["pid"]))
    print(isolation.stdout.decode(), flush=True)
    command("exec", name, "/usr/bin/touch", "/home/tool/gui-probe-continue")
    output, errors = probe_process.communicate(timeout=120)
    if probe_process.returncode:
        raise RuntimeError(errors.decode(errors="replace"))
    print(output.decode(), flush=True)
    after = until_json(["exec", "--user=1001:1001", name, "/bin/cat", "/home/app/session/gui-ledger.json"], lambda value: value["text"] == "W8 暂存" and value["count"] == 1)
    assert after == {"uid": 1001, "pid": ledger["pid"], "text": "W8 暂存", "count": 1}, after
    print(json.dumps({"independentApplicationLedger": after}), flush=True)
    # 四模式共用绝对 150s，最终清理独立最多 10s；宿主 180s 另留 20s 给启动/调度/进程退出。
    drain = command("exec", name, "/usr/local/bin/node", "/opt/kaguya-tools/gui-drain-probe.mjs", timeout=180)
    print(drain.stdout.decode(), flush=True)
    preserved = json.loads(command("exec", "--user=1001:1001", name, "/bin/cat", "/home/app/session/gui-ledger.json").stdout)
    assert preserved == after, preserved
    command("exec", "--detach", "--user=1001:1001", "--env=HOME=/home/app/session", "--env=GTK_MODULES=gail:atk-bridge", "--env=NO_AT_BRIDGE=0", name, "/usr/local/bin/node", "/opt/kaguya-tools/gui-chromium-fixture.mjs")
    browser = until_json(["exec", "--user=1001:1001", name, "/bin/cat", "/home/app/session/chromium-fixture.json"],
                         lambda value: published_identity(value, 1001) and isinstance(value.get("url"), str) and value["url"].startswith("http://127.0.0.1:"))
    browser_identity = application_identity(browser["pid"])
    browser_result = command("exec", name, "/usr/local/bin/node", "/opt/kaguya-tools/gui-chromium-probe.mjs", str(browser["pid"]), timeout=120)
    print(browser_result.stdout.decode(), flush=True)
    browser_after = until_json(["exec", "--user=1001:1001", name, "/bin/cat", "/home/app/session/chromium-ledger.json"], lambda value: value["text"] == "W8 browser ASCII" and value["count"] == 1)
    assert browser_after == {"uid": 1001, "pid": browser["pid"], "text": "W8 browser ASCII", "count": 1}, browser_after
    print(json.dumps({"independentBrowserLedger": browser_after, "sandboxPolicy": "chromium-v1", "seccompSha256": hashlib.sha256(selected_profile.read_bytes()).hexdigest()}), flush=True)
    command("exec", name, "/usr/bin/dbus-send", "--session", "--print-reply", "--dest=org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus.StartServiceByName", "string:org.kaguya.GuiAcceptance", "uint32:0")
    command("exec", name, "/usr/local/bin/node", "/opt/kaguya-tools/gui-launch-probe.mjs", timeout=120)
    launches = []
    for kind in ("activation", "shortcut", "menu"):
        marker = until_json(["exec", "--user=1001:1001", name, "/bin/cat", f"/home/app/session/launch-{kind}.json"],
                            lambda value: published_identity(value, 1001) and value.get("kind") == kind)
        assert marker["kind"] == kind and marker["uid"] == 1001 and marker["pid"] > 1, marker
        launches.append(marker)
    print(json.dumps({"applicationLaunches": launches}), flush=True)
    for filename, expected in [("gui-ledger.json", after), ("chromium-ledger.json", browser_after)]:
        preserved = json.loads(command("exec", "--user=1001:1001", name, "/bin/cat", "/home/app/session/" + filename).stdout)
        assert preserved == expected, preserved
    assert application_identity(ledger["pid"]) == gtk_identity
    assert application_identity(browser["pid"]) == browser_identity
    print(json.dumps({"applicationsPreserved": [gtk_identity, browser_identity]}), flush=True)
    Path("gui-probe.json").write_bytes(command("exec", name, "/bin/cat", "/home/tool/gui-probe.json").stdout)
    Path("gui-packages.txt").write_bytes(command("exec", name, "/bin/cat", "/usr/share/kaguya-gui-packages.txt").stdout)
    print(json.dumps({"imageDigest": args.digest, "ociProcess": oci["process"], "rootless": True}), flush=True)
finally:
    primary = sys.exc_info()[1]
    cleanup_errors = []
    if primary:
        try:
            print(f"Primary GUI failure: {primary!r}", file=sys.stderr, flush=True)
            Path("gui-failure.txt").write_text("".join(traceback.format_exception(primary)))
        except Exception as error:
            cleanup_errors.append(error)
    try:
        if not podman_unresponsive:
            # 双 GUI 应用、桌面服务与 Cua 的线程共同计入 pids 配额；记录内核计数，
            # 使 renderer 的 pthread_create EAGAIN 可与该配额的实际命中区分。
            resources = command("exec", name, "/usr/bin/python3", "-c",
                "import json,pathlib; p=pathlib.Path('/sys/fs/cgroup'); "
                "print(json.dumps({n:(p/n).read_text() for n in "
                "['pids.current','pids.max','pids.events','memory.current','memory.events'] if (p/n).exists()}))", check=False)
            Path("gui-resources.json").write_bytes(resources.stdout)
    except Exception as error:
        cleanup_errors.append(error)
    for source, destination in [("/home/tool/gui-probe.json", "gui-probe.json"),
                                ("/home/tool/gui-gtk.png", "gui-gtk.png"),
                                ("/home/tool/gui-desktop.png", "gui-desktop.png"),
                                ("/home/tool/gui-chromium.png", "gui-chromium.png"),
                                ("/home/tool/gui-chromium-probe.json", "gui-chromium-probe.json"),
                                ("/home/app/session/chromium.log", "gui-chromium.log"),
                                ("/home/app/session/chromium-ledger.json", "gui-chromium-ledger.json"),
                                ("/home/app/session/gui-ledger.json", "gui-gtk-ledger.json"),
                                ("/run/kaguya-app/session/gui-key-events.json", "gui-key-events.json"),
                                ("/home/tool/gui-drain-held.json", "gui-drain-held.json"),
                                ("/home/tool/gui-drain-modifier.json", "gui-drain-modifier.json"),
                                ("/home/tool/gui-drain-button.json", "gui-drain-button.json"),
                                ("/home/tool/gui-drain-unicode.json", "gui-drain-unicode.json"),
                                ("/home/tool/gui-menu.png", "gui-menu.png"),
                                ("/home/tool/gui-menu-observation.json", "gui-menu-observation.json"),
                                ("/home/tool/gui-menu-state.json", "gui-menu-state.json"),
                                ("/usr/share/kaguya-gui-packages.txt", "gui-packages.txt")]:
        if podman_unresponsive:
            break
        try:
            reader = ["--user=1001:1001"] if source.startswith("/home/app/") else []
            value = command("exec", *reader, name, "/bin/cat", source, check=False)
            if value.returncode == 0:
                Path(destination).write_bytes(value.stdout)
        except Exception as error:
            cleanup_errors.append(error)
    try:
        if not podman_unresponsive:
            app_logs = command("exec", "--user=1001:1001", name, "/usr/bin/tail", "-c", "65536", "/home/app/session/session.log", check=False)
            print(app_logs.stdout.decode(errors="replace"), flush=True)
    except Exception as error:
        cleanup_errors.append(error)
    try:
        if not podman_unresponsive:
            logs = command("logs", name, check=False)
            print(logs.stdout.decode(errors="replace"), flush=True)
            print(logs.stderr.decode(errors="replace"), flush=True)
    except Exception as error:
        cleanup_errors.append(error)
    try:
        command("rm", "--force", "--ignore", name)
    except Exception as error:
        cleanup_errors.append(error)
    if probe_process is not None:
        try:
            if probe_process.poll() is None:
                probe_process.kill()
            probe_process.wait(timeout=5)
        except Exception as error:
            cleanup_errors.append(error)
    if cleanup_errors:
        raise BaseExceptionGroup("gui fixture cleanup failed", ([primary] if primary else []) + cleanup_errors)
