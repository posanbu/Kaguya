#!/usr/bin/env python3
"""功能概述：合成桌面菜单、快捷键及 D-Bus 激活的进程身份回执，不承担控制授权。
主要职责：验证实际 UID1001，原子保存入口来源/PID/父 PID；activation 取得固定总线名称。
代码库关系：Openbox 固定配置与 org.kaguya.GuiAcceptance.service 启动，宿主只读核对结果。
输入输出与副作用：只接受三个固定来源；不运行 argv/脚本，不连接模型或宿主桌面。
"""
import json
import os
from pathlib import Path
import sys

kind = sys.argv[1]
if kind not in ("menu", "shortcut", "activation") or os.getuid() != 1001:
    raise RuntimeError("gui-marker-denied")


def record():
    path = Path(f"/home/app/session/launch-{kind}.json")
    temporary = path.with_suffix(".pending")
    with temporary.open("w") as output:
        json.dump({"kind": kind, "uid": os.getuid(), "pid": os.getpid(), "ppid": os.getppid()}, output)
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(path)


if kind == "activation":
    from gi.repository import Gio, GLib
    loop = GLib.MainLoop()
    owner = Gio.bus_own_name(Gio.BusType.SESSION, "org.kaguya.GuiAcceptance", Gio.BusNameOwnerFlags.NONE,
                             None, lambda *_: record(), lambda *_: loop.quit())
    try:
        loop.run()
    finally:
        Gio.bus_unown_name(owner)
else:
    record()
