#!/usr/bin/env python3
"""功能概述：使用保留目录 FD 的 openat/O_NOFOLLOW 读取 workspace 文件，消除中间目录替换竞态。
主要职责：逐段拒绝 symlink/路径穿越，只接受普通文件，流式计算整体 hash 并有界返回附件。
代码库关系：service.mjs 传入受信 root 与相对路径；job 看不到服务状态目录，不能变更内部回执。
输入输出与副作用：只读文件，stdout 单 JSON，失败只发稳定代码；不会执行模型或启动 shell。
"""
import base64
import hashlib
import json
import os
import stat
import sys


def open_beneath(root, path, after_directory=None):
    parts = path.split("/")
    if not parts or any(p in ("", ".", "..", ".kaguya-tools") or "\\" in p or "\0" in p for p in parts):
        raise ValueError("workspace-path-denied")
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        if after_directory:
            after_directory()
        file_fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    finally:
        os.close(fd)
    return file_fd


def main():
    root, path, offset, length, expected = sys.argv[1:]
    offset, length = int(offset), int(length)
    if offset < 0 or not 0 <= length <= 16777216:
        raise ValueError("invalid-export-range")
    file_fd = open_beneath(root, path)
    with os.fdopen(file_fd, "rb") as source:
        before = os.fstat(source.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise ValueError("regular-file-required")
        h = hashlib.sha256()
        while chunk := source.read(1048576):
            h.update(chunk)
        after = os.fstat(source.fileno())
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError("file-changed-during-read")
        sha = h.hexdigest()
        if expected and expected != sha:
            raise ValueError("export-hash-mismatch")
        result = {"size": before.st_size, "sha256": sha}
        if length:
            source.seek(offset)
            data = source.read(length)
            final = os.fstat(source.fileno())
            if (after.st_size, after.st_mtime_ns, after.st_ctime_ns) != (final.st_size, final.st_mtime_ns, final.st_ctime_ns):
                raise ValueError("file-changed-during-read")
            result.update(offset=offset, bytes=len(data), partSha256=hashlib.sha256(data).hexdigest(), dataBase64=base64.b64encode(data).decode())
        print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error) if isinstance(error, ValueError) else "unsafe-workspace-path", file=sys.stderr)
        sys.exit(1)
