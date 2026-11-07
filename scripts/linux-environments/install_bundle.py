#!/usr/bin/env python3
"""功能概述：供 Linux 本机受信用户执行已审查的一次性 W7/W8 安装包。
主要职责：verify_manifest 校验固定源码、OCI 归档、不可变镜像引用及包内 CI/GUI 回执的一致性；
verify_ci_evidence 供制包和安装复用离线证据检查，不证明远端 CI 状态。install 调用 bootstrap 的预检与管理员 apply，
随后以原用户复制归档并调用 broker image.import；rollback 只复用 bootstrap 的保留数据回退。
代码库关系：package_bundle.py 生成 manifest；特权系统变更全部由同目录 bootstrap.py 实现。
输入输出与副作用：不创建环境、不改 Kaguya Profile/数据库/QQ，不调用模型；镜像身份和回执写入用户目录。
安装进度可重试；已有 inbox 文件必须内容相同，不覆盖不明文件；失败保留实际状态供核对。
"""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import platform
import pwd
import re
import shutil
import socket
import stat
import subprocess
import time

SOURCE_FILES = ("bootstrap.py", "server.py", "broker.py", "shell_jobs.py", "job_runner.py",
                "packages.lock.json", "chromium-seccomp.json", "chromium-seccomp-podman5.json", "install_bundle.py")
IMAGE_ROLES = ("shell", "chromium", "gui")


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def regular(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise RuntimeError("bundle-nonregular-file")


def verify_ci_evidence(run, receipt, sha, images):
    if (not isinstance(run, dict) or run.get("head_sha") != sha or
            run.get("conclusion") != "success" or run.get("status") != "completed" or
            not isinstance(run.get("html_url"), str) or not run["html_url"].startswith("https://")):
        raise RuntimeError("bundle-ci-not-passed")
    if (not isinstance(receipt, dict) or receipt.get("passed") is not True or
            receipt.get("existingHomeRecovered") is not True):
        raise RuntimeError("bundle-gui-provider-not-passed")
    if receipt.get("imageDigest") != images["gui"]["image"].split("@", 1)[1]:
        raise RuntimeError("bundle-receipt-image-mismatch")


def verify_manifest(root, images=True):
    regular(root / "manifest.json")
    manifest = json.loads((root / "manifest.json").read_text())
    if (not isinstance(manifest, dict) or manifest.get("version") != 1 or
            not isinstance(manifest.get("commit"), str) or
            not re.fullmatch(r"[a-f0-9]{40}", manifest["commit"]) or
            not isinstance(manifest.get("sources"), dict) or
            set(manifest["sources"]) != set(SOURCE_FILES)):
        raise RuntimeError("bundle-manifest-invalid")
    for name, expected in manifest["sources"].items():
        regular(root / name)
        if digest(root / name) != expected:
            raise RuntimeError("bundle-source-checksum-mismatch")
    if images:
        if not isinstance(manifest.get("images"), dict) or set(manifest["images"]) != set(IMAGE_ROLES):
            raise RuntimeError("bundle-images-missing")
        for role, image in manifest["images"].items():
            if not isinstance(image, dict) or image.get("file") != role + "-tools.oci":
                raise RuntimeError("bundle-image-path-invalid")
            if (not isinstance(image.get("archiveSha256"), str) or
                    not re.fullmatch(r"[a-f0-9]{64}", image["archiveSha256"]) or
                    not isinstance(image.get("image"), str) or
                    not re.fullmatch(r"localhost/kaguya-" + role + r"@sha256:[a-f0-9]{64}", image["image"])):
                raise RuntimeError("bundle-image-identity-invalid")
            path = root / image["file"]
            regular(path)
            if digest(path) != image["archiveSha256"]:
                raise RuntimeError("bundle-image-checksum-mismatch")
        for name in ("workflow-run.json", "gui-provider-receipt.json"):
            regular(root / name)
        run = json.loads((root / "workflow-run.json").read_text())
        receipt = json.loads((root / "gui-provider-receipt.json").read_text())
        verify_ci_evidence(run, receipt, manifest["commit"], manifest["images"])
        if run["html_url"] != manifest.get("workflowRun"):
            raise RuntimeError("bundle-ci-reference-mismatch")
    return manifest


def rpc(method, params, timeout=310):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(timeout)
        connection.connect("/run/kaguya-tools/broker.sock")
        connection.sendall(json.dumps({"protocol": 1, "method": method, "params": params}).encode() + b"\n")
        with connection.makefile("rb") as stream:
            data = stream.readline(1024 * 1024)
    if not data.endswith(b"\n"):
        raise RuntimeError("broker-response-incomplete")
    response = json.loads(data)
    if response.get("ok") is not True:
        raise RuntimeError("broker-operation-unconfirmed")
    return response["result"]


def set_broker_read_acl(fd, broker_uid):
    # acl_set_fd 绑定已验证 inode；不对可被另一 UID 替换的目录项调用 setfacl。
    lib = ctypes.CDLL("libacl.so.1", use_errno=True)
    lib.acl_from_text.argtypes = [ctypes.c_char_p]
    lib.acl_from_text.restype = ctypes.c_void_p
    lib.acl_set_fd.argtypes = [ctypes.c_int, ctypes.c_void_p]
    lib.acl_get_fd.argtypes = [ctypes.c_int]
    lib.acl_get_fd.restype = ctypes.c_void_p
    lib.acl_cmp.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    lib.acl_free.argtypes = [ctypes.c_void_p]
    desired = lib.acl_from_text(f"u::rw-,u:{broker_uid}:r--,g::---,m::r--,o::---".encode())
    if not desired:
        raise RuntimeError("image-acl-invalid")
    actual = None
    try:
        if lib.acl_set_fd(fd, desired) != 0:
            raise OSError(ctypes.get_errno(), "image-acl-set-failed")
        actual = lib.acl_get_fd(fd)
        if not actual or lib.acl_cmp(actual, desired) != 0:
            raise RuntimeError("image-acl-readback-mismatch")
    finally:
        if actual:
            lib.acl_free(actual)
        lib.acl_free(desired)


def stage_image(root, image, inbox, broker_uid):
    target = inbox / (image["archiveSha256"] + ".oci")
    created = False
    try:
        fd = os.open(target, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        created = True
    except FileExistsError:
        fd = os.open(target, os.O_RDWR | os.O_NOFOLLOW)
    with os.fdopen(fd, "r+b") as dst:
        info = os.fstat(dst.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid():
            raise RuntimeError("inbox-file-owner-or-type-invalid")
        if created:
            with (root / image["file"]).open("rb") as src:
                shutil.copyfileobj(src, dst, 1024 * 1024)
            dst.flush()
            os.fsync(dst.fileno())
        dst.seek(0)
        if hashlib.file_digest(dst, "sha256").hexdigest() != image["archiveSha256"]:
            raise RuntimeError("existing-inbox-checksum-mismatch")
        def same_inode():
            current = target.lstat()
            retained = os.fstat(dst.fileno())
            if not stat.S_ISREG(current.st_mode) or retained.st_nlink != 1 or (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
                raise RuntimeError("inbox-path-replaced")
        same_inode()
        set_broker_read_acl(dst.fileno(), broker_uid)
        same_inode()
        os.fsync(dst.fileno())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["verify", "install", "rollback"])
    parser.add_argument("--trusted-user", required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    manifest = verify_manifest(root, images=args.mode != "rollback")
    if args.mode == "verify":
        print(json.dumps({"verified": True, "commit": manifest["commit"]}))
        return
    if platform.system() != "Linux" or os.geteuid() == 0 or pwd.getpwnam(args.trusted_user).pw_uid != os.getuid():
        raise RuntimeError("run-as-trusted-user-on-linux")
    command = ["/usr/bin/python3", "-I", str(root / "bootstrap.py")]
    if args.mode == "rollback":
        subprocess.run(["sudo", *command, "rollback", "--trusted-user", args.trusted_user], check=True)
        return
    subprocess.run([*command, "check", "--trusted-user", args.trusted_user], check=True)
    subprocess.run(["sudo", *command, "apply", "--trusted-user", args.trusted_user], check=True)
    # systemd 的启动完成不等于 socket ready；最多 30 秒，只读 health 确认后导入。
    deadline = time.monotonic() + 30
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError("broker-not-ready")
        try:
            if rpc("health", {}, timeout=min(2, remaining)).get("ready") is True:
                break
        except (OSError, RuntimeError):
            pass
        if time.monotonic() >= deadline:
            raise RuntimeError("broker-not-ready")
        time.sleep(0.2)
    receipts = []
    for role in IMAGE_ROLES:
        image = manifest["images"][role]
        inbox = Path("/var/lib/kaguya-tools-storage/containers/inbox")
        stage_image(root, image, inbox, pwd.getpwnam("kaguya-tools").pw_uid)
        result = rpc("image.import", {"sha256": image["archiveSha256"]})
        if result != {"imported": True, "archiveSha256": image["archiveSha256"]}:
            raise RuntimeError("image-import-unconfirmed")
        receipts.append({"role": role, **image, "result": result})
    receipt = root / ("installation-receipt-" + str(time.time_ns()) + ".json")
    with os.fdopen(os.open(receipt, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
        json.dump({"commit": manifest["commit"], "images": receipts, "health": rpc("health", {})}, stream, indent=2)
    print(str(receipt))


if __name__ == "__main__":
    main()
