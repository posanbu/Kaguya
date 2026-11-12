#!/usr/bin/env python3
"""功能概述：宿主固定 podman exec --user 1001:1001 启动的应用会话，不承担控制授权。
主要职责：等待真实 X11 就绪，启动固定 session bus、AT-SPI、Openbox 与终端；派生进程均为应用 UID。
代码库关系：gui-session.conf 禁用用户 activation 搜索；gui-init.mjs 独立拥有 Xvfb。
生产 HOME 是命名卷 /private/app，验收模式使用临时 HOME 和专用身份标记菜单。
输入输出与副作用：只接受镜像内固定程序；子进程异常使会话失败，SIGTERM 回收本会话子进程。
"""
import os
from pathlib import Path
import signal
import subprocess
import time

if os.getuid() != 1001:
    raise RuntimeError("gui-app-uid-required")
for directory, mode in [("/home/app/session", 0o700), ("/run/kaguya-app/session", 0o711),
                        ("/run/kaguya-app/session/at-spi", 0o711)]:
    path = Path(directory)
    path.mkdir(mode=mode, exist_ok=True)
    info = path.lstat()
    if path.is_symlink() or info.st_uid != 1001 or info.st_mode & 0o022:
        raise RuntimeError("unsafe-app-session-directory")
acceptance = os.environ.get("KAGUYA_GUI_ACCEPTANCE") == "1"
home = "/home/app/session" if acceptance else "/private/app"
home_info = Path(home).lstat()
if Path(home).is_symlink() or home_info.st_uid != 1001 or home_info.st_mode & 0o077:
    raise RuntimeError("unsafe-app-home")
log = os.open("/home/app/session/session.log", os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
os.dup2(log, 1)
os.dup2(log, 2)
os.close(log)
os.environ.update(HOME=home, DISPLAY=":99", XDG_RUNTIME_DIR="/run/kaguya-app/session",
                  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/kaguya-app/session/bus",
                  GTK_MODULES="gail:atk-bridge", NO_AT_BRIDGE="0", GTK_A11Y="always")
children = []
critical = []


def start(args, required=True):
    child = subprocess.Popen(args)
    children.append(child)
    if required:
        critical.append(child)
    return child


def ready(args, seconds=12, accepts=lambda _output: True):
    deadline = time.monotonic() + seconds
    while True:
        check_children()
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=2)
        if result.returncode == 0 and accepts(result.stdout):
            return
        if time.monotonic() >= deadline:
            raise RuntimeError("gui-session-not-ready")
        time.sleep(.02)


def check_children():
    for child in critical:
        if child.poll() is not None:
            raise RuntimeError(f"gui-session-child-exited: {child.args!r} code={child.returncode}")


def stop(_signum, _frame):
    raise SystemExit(0)


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    ready(["/usr/bin/xdpyinfo"])
    start(["/usr/bin/dbus-daemon", "--nofork", "--config-file=/opt/kaguya-tools/gui-session.conf"])
    ready(["/usr/bin/dbus-send", "--session", "--print-reply", "--dest=org.freedesktop.DBus", "/", "org.freedesktop.DBus.ListNames"])
    # 只通过镜像内固定 D-Bus service 激活一次。显式 launcher 与 GetAddress 自动激活
    # 竞争同一名称时，后启动的 launcher 正常退出，不能误判为整个应用会话失败。
    ready(["/usr/bin/dbus-send", "--session", "--print-reply", "--dest=org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus.GetAddress"])
    config = "gui-openbox.xml" if acceptance else "gui-openbox-production.xml"
    start(["/usr/bin/openbox", "--config-file", "/opt/kaguya-tools/" + config])
    ready(["/usr/bin/xprop", "-root", "_NET_SUPPORTING_WM_CHECK"], accepts=lambda output: b"window id # 0x" in output)
    start(["/usr/bin/xterm", "-fa", "monospace", "-fs", "11", "-title", "Kaguya isolated terminal"], required=False)
    Path("/run/kaguya-app/session/ready").write_text("ready\n")
    while True:
        # 这里是会话存活监视；就绪和测试行为使用上方有界条件，不以休眠猜测完成。
        check_children()
        time.sleep(.2)
finally:
    for child in children:
        if child.poll() is None:
            child.terminate()
    for child in children:
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=3)
