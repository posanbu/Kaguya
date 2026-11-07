#!/usr/bin/env python3
"""功能概述：以真实 app UID 尝试访问控制 socket、Driver 进程和只读 helper 路径。
主要职责：每项必须获得内核拒绝；ptrace 意外成功时立即 detach 并使测试失败。
代码库关系：Linux 宿主在 gui-probe 保持 Driver 存活期间固定 exec UID1001 调用。
输入输出与副作用：仅合成拒绝探针，无模型/用户内容；不把目录名称或静态 mode 当隔离证明。
"""
import ctypes
import errno
import json
import os
import signal
import socket
import sys

if os.getuid() != 1001:
    raise RuntimeError("isolation-probe-app-uid-required")
pid = int(sys.argv[1])
assert pid > 1
checks = []


def denied(name, action):
    try:
        action()
    except OSError as error:
        assert error.errno in (errno.EACCES, errno.EPERM, errno.EROFS), (name, error)
        checks.append(name)
        return
    raise AssertionError("app unexpectedly allowed: " + name)


def connect():
    with socket.socket(socket.AF_UNIX) as client:
        client.connect("/home/tool/kaguya-tools.sock")


def read(path):
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    os.close(fd)


def create(path):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o700)
    os.close(fd)
    os.unlink(path)


denied("control-connect", connect)
denied("control-unlink", lambda: os.unlink("/home/tool/kaguya-tools.sock"))
denied("control-replace", lambda: create("/home/tool/forged-ack"))
denied("driver-environ", lambda: read(f"/proc/{pid}/environ"))
denied("driver-stdin", lambda: read(f"/proc/{pid}/fd/0"))
denied("driver-signal", lambda: os.kill(pid, 0))
denied("trusted-path-write", lambda: create("/opt/cua/helpers/wish"))
libc = ctypes.CDLL(None, use_errno=True)
result = libc.ptrace(16, pid, 0, 0)  # PTRACE_ATTACH
if result == 0:
    os.waitpid(pid, os.WUNTRACED)
    libc.ptrace(17, pid, 0, 0)
    raise AssertionError("app unexpectedly attached to Driver")
assert ctypes.get_errno() == errno.EPERM
checks.append("driver-ptrace")
print(json.dumps({"uid": os.getuid(), "driverPid": pid, "denied": checks}))
