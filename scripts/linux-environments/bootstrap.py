#!/usr/bin/env python3
"""功能概述：由用户在 Linux 本机执行的一次管理员安装入口，不从聊天代理执行 sudo。
主要职责：check 只读预检；apply 安装 rootless 前置、专用账户、UID 网络策略与用户 broker；
rollback 只停用本安装的服务和规则，保留账户、subid、操作日志、工作区与产物。
代码库关系：将同目录 broker、supervisor 与固定 Chromium seccomp 安装为 root 拥有的文件；runtime/environment.ts
通过固定 Unix socket 调用。安装不拉取镜像、不创建任务、不接触 Kaguya/QQ/PostgreSQL。
输入输出与副作用：固定系统路径，显式受信用户名；拒绝符号链接、冲突账户和现存异构配置。
"""
import argparse
import fcntl
import grp
import hashlib
import json
import os
from pathlib import Path
import platform
import pwd
import re
import shutil
import stat
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from broker import verify_storage_mount  # noqa: E402

ACCOUNT = "kaguya-tools"
STATE = Path("/var/lib/kaguya-tools")
CODE = Path("/usr/local/lib/kaguya-tools")
CONFIG = Path("/etc/kaguya-tools")
STORAGE = Path("/var/lib/kaguya-tools-storage")
PACKAGES = ["podman", "golang-github-containers-common", "uidmap", "passt", "crun", "fuse-overlayfs", "python3",
            "dbus-user-session", "libpam-systemd", "ca-certificates", "acl", "nftables", "e2fsprogs", "util-linux"]
ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"}


def run(*args, capture=False, check=True):
    return subprocess.run(args, env=ENV, check=check, text=True,
                          stdout=subprocess.PIPE if capture else None,
                          timeout=600)


def safe_path(path):
    for part in [path, *path.parents]:
        if part.is_symlink():
            raise RuntimeError("symlink-install-path")
        if part.exists() and part != STATE and part != Path("/"):
            st = part.stat()
            if st.st_uid != 0 or st.st_mode & 0o022:
                raise RuntimeError("untrusted-install-path")


def write_root(path, content, mode=0o644):
    safe_path(path.parent)
    if path.is_symlink():
        raise RuntimeError("symlink-install-target")
    temp = path.with_name(path.name + ".install")
    if temp.exists() or temp.is_symlink():
        safe_path(temp)
        if not temp.is_file():
            raise RuntimeError("unexpected-install-staging-file")
        temp.unlink()
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd, "w") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.chown(temp, 0, 0)
        os.chmod(temp, mode)
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def ranges(path):
    result = []
    for line in Path(path).read_text().splitlines():
        if line.strip():
            name, start, length = line.split(":")
            result.append((name, int(start), int(length)))
    return result


def check_subids():
    for path in ("/etc/subuid", "/etc/subgid"):
        rows = ranges(path)
        own = [r for r in rows if r[0] == ACCOUNT]
        if len(own) != 1 or own[0][2] < 65536:
            raise RuntimeError("invalid-subid-allocation")
        _, start, count = own[0]
        if any(n != ACCOUNT and start < s + c and s < start + count for n, s, c in rows):
            raise RuntimeError("overlapping-subid-allocation")


def installed_identity():
    if not CONFIG.exists():
        return None
    safe_path(CONFIG)
    for name in ("config.json", "install-state.json"):
        path = CONFIG / name
        if path.exists():
            safe_path(path)
            value = json.loads(path.read_text())
            if value.get("installation") != "kaguya-linux-environments-v1":
                raise RuntimeError("foreign-installation-config")
            return value
    # mkdir 或首个 atomic rename 之间中断；尚未创建 W6 挂载/单元。
    entries = list(CONFIG.iterdir())
    if any(p.name != "install-state.json.install" for p in entries):
        raise RuntimeError("unrecognized-partial-installation")
    for path in entries:
        safe_path(path)
    return None


def preflight(user, installing=True):
    if platform.system() != "Linux" or platform.machine() != "x86_64":
        raise RuntimeError("requires-linux-x86_64")
    release = Path("/etc/os-release").read_text()
    if 'ID=ubuntu' not in release or 'VERSION_ID="26.04"' not in release:
        raise RuntimeError("requires-reviewed-ubuntu-26.04")
    trusted = pwd.getpwnam(user)
    if trusted.pw_uid == 0 or user == ACCOUNT:
        raise RuntimeError("invalid-trusted-user")
    if not Path("/sys/fs/cgroup/cgroup.controllers").exists():
        raise RuntimeError("requires-cgroup-v2")
    for path in (STATE, CODE, CONFIG, Path("/run/kaguya-tools")):
        if path.is_symlink():
            raise RuntimeError("symlink-install-path")
    needed, reclaimable = 0, 0
    for name, size in (("containers", 24), ("state", 4)):
        if (STORAGE / (name + ".img")).exists():
            continue
        needed += size
        stage = STORAGE / (name + ".preparing")
        if installing and (stage.exists() or stage.is_symlink()):
            account = pwd.getpwnam(ACCOUNT)
            info = validated_staging(stage, size, account.pw_uid)
            reclaimable += min(info.st_blocks * 512, size * 1024 ** 3)
    if installing and shutil.disk_usage("/var/lib").free + reclaimable < (needed + 4) * 1024 ** 3:
        raise RuntimeError("insufficient-install-capacity")
    return trusted


def validated_staging(temp, gib, service_uid):
    safe_path(STORAGE)
    owner = installed_identity()
    stage = temp.lstat()
    if (owner is None or owner.get("serviceUid") != service_uid or
            not stat.S_ISREG(stage.st_mode) or stage.st_uid != 0 or
            stage.st_mode & 0o077 or stage.st_nlink != 1 or stage.st_size > gib * 1024 ** 3):
        raise RuntimeError("unrecognized-storage-staging")
    if run("losetup", "--associated", str(temp), "--noheadings", capture=True).stdout.strip():
        raise RuntimeError("storage-staging-still-attached")
    return stage


def provision_storage(account, trusted):
    safe_path(STORAGE)
    STORAGE.mkdir(mode=0o755, exist_ok=True)
    units = []
    for name, gib in (("containers", 24), ("state", 4)):
        image = STORAGE / (name + ".img")
        mountpoint = STORAGE / name
        if image.is_symlink() or mountpoint.is_symlink():
            raise RuntimeError("symlink-storage")
        if not image.exists():
            temp = STORAGE / (name + ".preparing")
            if temp.exists() or temp.is_symlink():
                # 仅恢复已登记安装留下的 staging；已发布 .img 永不重新格式化。
                validated_staging(temp, gib, account.pw_uid)
                temp.unlink()
            fd = os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            os.close(fd)
            try:
                run("fallocate", "-l", str(gib * 1024 ** 3), str(temp))
                run("mkfs.ext4", "-q", "-E", "nodiscard,lazy_itable_init=0,lazy_journal_init=0", "-L", "kaguya-" + name, str(temp))
                if temp.stat().st_blocks * 512 < temp.stat().st_size:
                    raise RuntimeError("storage-reservation-lost")
                os.rename(temp, image)
            finally:
                temp.unlink(missing_ok=True)
        if image.stat().st_uid != 0 or image.stat().st_mode & 0o077 or image.stat().st_size != gib * 1024 ** 3 or image.stat().st_blocks * 512 < image.stat().st_size:
            raise RuntimeError("conflicting-storage-image")
        if run("blkid", "-s", "LABEL", "-o", "value", str(image), capture=True).stdout.strip() != "kaguya-" + name:
            raise RuntimeError("unrecognized-storage-image")
        mountpoint.mkdir(mode=0o700, exist_ok=True)
        unit = run("systemd-escape", "--path", "--suffix=mount", str(mountpoint), capture=True).stdout.strip()
        units.append(unit)
        write_root(Path("/etc/systemd/system") / unit, f"""[Unit]
Description=Bounded persistent Kaguya {name} storage
[Mount]
What={image}
Where={mountpoint}
Type=ext4
Options=loop,nodev,nosuid{',noexec' if name == 'state' else ''}
[Install]
WantedBy=multi-user.target
""")
        run("systemctl", "daemon-reload")
        run("systemctl", "enable", "--now", unit)
        verify_storage_mount(mountpoint, image)
        os.chown(mountpoint, account.pw_uid, account.pw_gid)
        os.chmod(mountpoint, 0o700)
    # 唯一用户可写导入区；broker 将 OCI 复制进私有区并校验后才 load。
    inbox = STORAGE / "containers/inbox"
    inbox.mkdir(mode=0o700, exist_ok=True)
    os.chown(inbox, account.pw_uid, account.pw_gid)
    run("setfacl", "-m", f"u:{trusted.pw_uid}:--x", str(STORAGE / "containers"))
    run("setfacl", "-m", f"u:{trusted.pw_uid}:rwx", str(inbox))
    return units


def install_packages(source):
    manifest = json.loads((source / "packages.lock.json").read_text())
    pins = manifest["executionPackages"]
    if set(pins) != {"podman", "golang-github-containers-common", "uidmap", "passt", "crun", "fuse-overlayfs"} or manifest["source"] != "https://mirrors.ustc.edu.cn/ubuntu":
        raise RuntimeError("invalid-package-manifest")
    # 本次进程使用独立源和签名索引，避免同版本包被其他配置源抢选；不修改系统 APT 源。
    with tempfile.TemporaryDirectory(prefix="kaguya-tools-apt-") as directory:
        root = Path(directory)
        sources = root / "approved.sources"
        sources.write_text("Types: deb\nURIs: https://mirrors.ustc.edu.cn/ubuntu\n"
                           "Suites: resolute resolute-updates resolute-security\n"
                           "Components: main universe restricted multiverse\nArchitectures: amd64\n"
                           "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n")
        lists = root / "lists"
        lists.mkdir()
        options = ("-o", f"Dir::Etc::sourcelist={sources}", "-o", "Dir::Etc::sourceparts=-",
                   "-o", f"Dir::State::lists={lists}")
        return install_from_approved_sources(manifest, options)


def installed_package(name):
    result = run("dpkg-query", "-W", "-f=${Status}\\n${Version}", name, capture=True, check=False)
    lines = result.stdout.splitlines()
    return lines[1].strip() if result.returncode == 0 and len(lines) == 2 and lines[0] == "install ok installed" else ""


def install_from_approved_sources(manifest, options):
    pins = manifest["executionPackages"]
    run("apt-get", *options, "update")
    packages = []
    for name in PACKAGES:
        version = installed_package(name)
        if name in pins:
            pin = pins[name]
            if not re.fullmatch(r"[0-9][A-Za-z0-9.+:~_-]*", pin):
                raise RuntimeError("invalid-package-version")
            candidates = run("apt-cache", *options, "madison", name, capture=True).stdout.splitlines()
            if not any(len(parts := [s.strip() for s in line.split("|")]) == 3 and
                       parts[1] == pin and parts[2].startswith(manifest["source"] + " ") for line in candidates):
                raise RuntimeError("approved-package-version-unavailable:" + name)
            if version and run("dpkg", "--compare-versions", version, "gt", pin, check=False).returncode == 0:
                raise RuntimeError("package-downgrade-refused:" + name)
            packages.append(name + "=" + pin)
        elif not version:
            packages.append(name)
        # 已装系统包不要求升级，避免顺带升级用户会话或 OS 安全依赖。
    run("apt-get", *options, "install", "-y", "--no-install-recommends", *packages)
    actual = {}
    for name in PACKAGES:
        version = installed_package(name)
        if not version:
            raise RuntimeError("package-not-installed:" + name)
        actual[name] = version
        if name in pins and version != pins[name]:
            raise RuntimeError("installed-package-version-mismatch:" + name)
        if name in manifest["systemCompatibility"]:
            bounds = manifest["systemCompatibility"][name]
            if (run("dpkg", "--compare-versions", version, "ge", bounds["minimum"], check=False).returncode != 0 or
                    run("dpkg", "--compare-versions", version, "lt", bounds["maximumExclusive"], check=False).returncode != 0):
                raise RuntimeError("system-package-outside-reviewed-range:" + name)
    return manifest, actual


def firewall(uid):
    # 独立 table；不 flush 其他规则。public-web 拒绝本机和特殊地址，离线容器仍使用 network=none。
    return f"""table inet kaguya_tools {{
 chain output {{ type filter hook output priority -5; policy accept;
  meta skuid {uid} jump egress
 }}
 chain egress {{
  ip daddr 127.0.0.53 udp dport 53 accept
  ip daddr 127.0.0.53 tcp dport 53 accept
  fib daddr type local reject
  ip daddr {{ 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4 }} reject
  ip6 daddr {{ ::/96, ::ffff:0:0/96, 64:ff9b::/96, 64:ff9b:1::/48, 100::/64, 2001::/23, 2002::/16, fc00::/7, fe80::/10, ff00::/8 }} reject
  tcp dport {{ 80, 443 }} accept
  udp dport 53 accept
  tcp dport 53 accept
  reject
 }}
}}
"""


def userctl(uid, *args):
    return run("runuser", "-u", ACCOUNT, "--", "env",
               f"XDG_RUNTIME_DIR=/run/user/{uid}",
               f"DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{uid}/bus",
               "systemctl", "--user", *args)


def apply(user):
    trusted = preflight(user)
    if os.geteuid() != 0:
        raise RuntimeError("administrator-required")
    source = Path(__file__).resolve().parent
    # 先检查完整交付物，避免仅安装半套 broker 后开放入口。
    for name in ("server.py", "broker.py", "shell_jobs.py", "job_runner.py", "chromium-seccomp.json", "chromium-seccomp-podman5.json", "packages.lock.json"):
        if not (source / name).is_file() or (source / name).is_symlink():
            raise RuntimeError("missing-reviewed-broker-payload")
    try:
        account = pwd.getpwnam(ACCOUNT)
        if account.pw_dir != str(STATE) or account.pw_shell != "/usr/sbin/nologin":
            raise RuntimeError("conflicting-service-account")
        if any(g.gr_gid != account.pw_gid and ACCOUNT in g.gr_mem for g in grp.getgrall()):
            raise RuntimeError("service-account-extra-groups")
    except KeyError:
        account = None
    old = installed_identity()
    if old:
        if old.get("trustedUid") != trusted.pw_uid:
            raise RuntimeError("trusted-uid-change-requires-review")
        if account is None or old.get("serviceUid") != account.pw_uid:
            raise RuntimeError("service-uid-change-requires-review")
        # 同一安装重跑先排空 W6，避免运行中的代码与新包混用。
        active = run("systemctl", "is-active", f"user@{account.pw_uid}.service", check=False, capture=True)
        if active.returncode == 0:
            userctl(account.pw_uid, "stop", "kaguya-tools-broker.service")
    manifest, actual_versions = install_packages(source)
    if account is None:
        run("useradd", "--system", "--user-group", "--create-home", "--home-dir", str(STATE),
            "--shell", "/usr/sbin/nologin", ACCOUNT)
        account = pwd.getpwnam(ACCOUNT)
    for path, flag in (("/etc/subuid", "--add-subuids"), ("/etc/subgid", "--add-subgids")):
        rows = ranges(path)
        if not any(n == ACCOUNT for n, _, _ in rows):
            start = max([100000] + [s + c for _, s, c in rows])
            run("usermod", flag, f"{start}-{start + 65535}", ACCOUNT)
    check_subids()
    for directory in (CODE, CONFIG):
        safe_path(directory)
        directory.mkdir(mode=0o755, parents=True, exist_ok=True)
    write_root(CONFIG / "install-state.json", json.dumps({"installation": "kaguya-linux-environments-v1",
               "trustedUid": trusted.pw_uid, "serviceUid": account.pw_uid, "phase": "account-ready"}) + "\n")
    os.chmod(STATE, 0o700)
    os.chown(STATE, account.pw_uid, account.pw_gid)
    mounts = provision_storage(account, trusted)
    for name in ("server.py", "broker.py", "shell_jobs.py", "job_runner.py", "chromium-seccomp.json", "chromium-seccomp-podman5.json"):
        write_root(CODE / name, (source / name).read_text())
    config = {"installation": "kaguya-linux-environments-v1", "trustedUid": trusted.pw_uid, "serviceUid": account.pw_uid,
              "state": str(STORAGE / "state/broker"), "socket": "/run/kaguya-tools/broker.sock",
              "mounts": [str(STORAGE / "containers"), str(STORAGE / "state")],
              "maxEnvironments": 2, "maxArtifactBytes": 16777216,
              "maxStoredBytes": 2147483648, "protocol": 1}
    write_root(CONFIG / "config.json", json.dumps(config, indent=2) + "\n")
    write_root(CONFIG / "packages.lock.json", json.dumps(manifest, indent=2) + "\n")
    write_root(CONFIG / "storage.conf", f'[storage]\ndriver = "overlay"\ngraphroot = "{STORAGE}/containers/graph"\nrunroot = "/run/user/{account.pw_uid}/containers"\n')
    write_root(CONFIG / "network.nft", firewall(account.pw_uid))
    run("nft", "--check", "--file", str(CONFIG / "network.nft"))
    write_root(Path("/etc/systemd/system/kaguya-tools-network.service"), """[Unit]
Description=Kaguya tools UID egress boundary
Before=network-online.target
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/kaguya-tools/network.nft
ExecStop=/usr/sbin/nft delete table inet kaguya_tools
[Install]
WantedBy=multi-user.target
""")
    write_root(Path("/etc/tmpfiles.d/kaguya-tools.conf"),
               f"d /run/kaguya-tools 0710 {ACCOUNT} root -\na+ /run/kaguya-tools - - - - u:{trusted.pw_uid}:--x\n")
    # 将规则加载绑定到该专用用户 manager；不改 andrew 的 user manager。
    dropin = Path(f"/etc/systemd/system/user@{account.pw_uid}.service.d")
    dropin.mkdir(mode=0o755, parents=True, exist_ok=True)
    dependencies = " ".join(["kaguya-tools-network.service", *mounts])
    write_root(dropin / "kaguya-tools.conf", f"[Unit]\nRequires={dependencies}\nAfter={dependencies}\n")
    write_root(Path("/etc/systemd/user/kaguya-tools-broker.service"), f"""[Unit]
Description=Kaguya isolated environment broker
ConditionUser={ACCOUNT}
[Service]
ExecStart=/usr/bin/python3 -I {CODE}/server.py {CONFIG}/config.json
UMask=0077
Slice=kaguya.slice
Restart=on-failure
RestartSec=3
TimeoutStopSec=30
KillMode=control-group
Delegate=yes
MemoryMax=10G
TasksMax=1200
[Install]
WantedBy=default.target
""")
    run("systemd-tmpfiles", "--create", "/etc/tmpfiles.d/kaguya-tools.conf")
    run("systemctl", "daemon-reload")
    run("systemctl", "enable", "kaguya-tools-network.service")
    run("systemctl", "restart", "kaguya-tools-network.service")
    run("loginctl", "enable-linger", ACCOUNT)
    run("systemctl", "start", f"user@{account.pw_uid}.service")
    # 以实际专用 UID 运行 Podman，验证 AppArmor/userns/映射；绝不 rootful 回退。
    result = run("runuser", "-u", ACCOUNT, "--", "env",
                 f"XDG_RUNTIME_DIR=/run/user/{account.pw_uid}",
                 "CONTAINERS_STORAGE_CONF=/etc/kaguya-tools/storage.conf",
                 "podman", "info", "--format", "json", capture=True)
    info = json.loads(result.stdout)
    if not info["host"]["security"]["rootless"] or info["host"]["cgroupVersion"] != "v2":
        raise RuntimeError("rootless-self-check-failed")
    run("runuser", "-u", ACCOUNT, "--", "env", f"XDG_RUNTIME_DIR=/run/user/{account.pw_uid}",
        "CONTAINERS_STORAGE_CONF=/etc/kaguya-tools/storage.conf",
        "podman", "unshare", "cat", "/proc/self/uid_map")
    userctl(account.pw_uid, "daemon-reload")
    userctl(account.pw_uid, "enable", "--now", "kaguya-tools-broker.service")
    receipt = {"serviceUid": account.pw_uid, "trustedUid": trusted.pw_uid,
               "packages": actual_versions,
               "sourceHashes": {n: hashlib.sha256((source / n).read_bytes()).hexdigest()
                                for n in ("bootstrap.py", "server.py", "broker.py", "shell_jobs.py", "job_runner.py", "chromium-seccomp.json", "chromium-seccomp-podman5.json", "packages.lock.json")}}
    write_root(CONFIG / "installation.json", json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"installed": True, "serviceUid": account.pw_uid,
                      "trustedUid": trusted.pw_uid, "tasksStarted": 0}))


def rollback(user):
    trusted = preflight(user, installing=False)
    if os.geteuid() != 0:
        raise RuntimeError("administrator-required")
    config = installed_identity()
    if config is None:
        print("No installed broker; any empty installation directory is retained for retry.")
        return
    account = pwd.getpwnam(ACCOUNT)
    if config["trustedUid"] != trusted.pw_uid or config["serviceUid"] != account.pw_uid:
        raise RuntimeError("rollback-identity-mismatch")
    # broker 停止只隔离自动化并保留桌面；显式管理员回退另行停止独立 job 和桌面。
    active = run("systemctl", "is-active", f"user@{account.pw_uid}.service", check=False, capture=True)
    if active.returncode == 0 and Path("/etc/systemd/user/kaguya-tools-broker.service").exists():
        userctl(account.pw_uid, "disable", "--now", "kaguya-tools-broker.service")
        userctl(account.pw_uid, "stop", "kaguya-job-*.service", "kaguya-job-*-expiry.timer")
    if (CONFIG / "storage.conf").exists():
        command = ("runuser", "-u", ACCOUNT, "--", "env", f"XDG_RUNTIME_DIR=/run/user/{account.pw_uid}",
                   "CONTAINERS_STORAGE_CONF=/etc/kaguya-tools/storage.conf", "podman")
        managed = run(*command, "ps", "--filter", "label=kaguya.environment", "--format", "{{.ID}}", capture=True)
        for container in managed.stdout.split():
            if not re.fullmatch(r"[a-f0-9]{12,64}", container):
                raise RuntimeError("managed-container-identity-invalid")
            run(*command, "kill", "--signal=KILL", container, check=False)
            run(*command, "wait", container)
            state = json.loads(run(*command, "inspect", container, capture=True).stdout)[0]["State"]
            if state["Running"] or state.get("Pid", 0):
                raise RuntimeError("rollback-container-stop-unconfirmed")
        result = run(*command, "ps", "-q", capture=True)
        if result.stdout.strip():
            raise RuntimeError("containers-remain-network-boundary-retained")
    run("loginctl", "disable-linger", ACCOUNT)
    run("systemctl", "stop", f"user@{account.pw_uid}.service")
    Path(f"/etc/systemd/system/user@{account.pw_uid}.service.d/kaguya-tools.conf").unlink(missing_ok=True)
    if Path("/etc/systemd/system/kaguya-tools-network.service").exists():
        run("systemctl", "disable", "--now", "kaguya-tools-network.service")
    run("systemctl", "daemon-reload")
    print("Disabled W6 services; account, mappings, code, journal and artifacts retained.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["check", "apply", "rollback"])
    parser.add_argument("--trusted-user", required=True)
    args = parser.parse_args()
    try:
        # 管理员变更串行化；不能把另一个正在格式化的 staging 当作遗留文件。
        if args.mode != "check":
            if os.geteuid() != 0:
                raise RuntimeError("administrator-required")
            lock = os.open("/run/lock/kaguya-tools-install.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            info = os.fstat(lock)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
                raise RuntimeError("unsafe-install-lock")
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.mode == "check":
            trusted = preflight(args.trusted_user)
            print(json.dumps({"eligible": True, "trustedUid": trusted.pw_uid, "packages": PACKAGES}))
        elif args.mode == "apply":
            apply(args.trusted_user)
        else:
            rollback(args.trusted_user)
    except (RuntimeError, KeyError, OSError, subprocess.SubprocessError) as error:
        print(f"Bootstrap stopped: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
