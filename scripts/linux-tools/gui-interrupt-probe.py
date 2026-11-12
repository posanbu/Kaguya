#!/usr/bin/env python3
"""功能概述：CI 私有 X11 代理在真实 Cua 输入请求后建立屏障，再冻结并终止驱动组。
主要职责：先发布 proxy-ready，接收固定 driver PID 后 armed；屏障阻止后续 release/映射恢复，真实状态确认后核验整组停止。
代码库关系：gui-drain-probe.mjs 仅发送一次真实输入；gui_input_barrier 转发原始请求，gui-x11.py 独立读 :99。
输入输出与副作用：仅 UID1000 的本容器驱动；不生成输入、不改延迟，保留冻结/残留状态与实际 GTK 重复事件证据。
"""
import asyncio
import ctypes as C
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import struct
import sys
import time
from gui_input_barrier import InputBarrier, matches_request

spec = importlib.util.spec_from_file_location("gui_x11", Path(__file__).with_name("gui-x11.py"))
x11 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(x11)
MODES = {"held": 91, "modifier": 92, "button": 93, "unicode": 94}


def process_stat(path):
    fields = path.read_text().rsplit(")", 1)[1].split()
    return fields[0], int(fields[2]), fields[19]


def validate(pid, identity):
    if (os.readlink(f"/proc/{pid}/exe") != "/opt/cua/cua-driver" or os.getpgid(pid) != pid or
            Path(f"/proc/{pid}/stat").stat().st_uid != 1000 or
            process_stat(Path(f"/proc/{pid}/stat"))[2] != identity):
        raise RuntimeError("interrupt-probe-identity-changed")


def group_threads(pid):
    members = {}
    for process in Path("/proc").iterdir():
        if not process.name.isdigit():
            continue
        try:
            _, group, _ = process_stat(process / "stat")
            if group != pid:
                continue
            if (process / "stat").stat().st_uid != 1000:
                raise RuntimeError("interrupt-group-uid-changed")
            for task in (process / "task").iterdir():
                state, group, started = process_stat(task / "stat")
                if group != pid:
                    raise RuntimeError("interrupt-thread-group-changed")
                members[f"{process.name}/{task.name}"] = (state, started)
        except FileNotFoundError:
            # 组尚未停止时线程可退出；下一次完整观察必须稳定且全为 T。
            return {}
    return members


async def stopped_group(pid, identity, deadline):
    previous = None
    while time.monotonic() < deadline:
        validate(pid, identity)
        current = group_threads(pid)
        if current and all(state == "T" for state, _ in current.values()) and current == previous:
            return current
        previous = current
        await asyncio.sleep(.005)
    raise RuntimeError("interrupt-group-stop-unconfirmed")


def matches(state, mode):
    if mode == "unicode":
        return any(0x1004e2d in row for row in state["mapping"])
    if mode == "button":
        return 1 in state["buttons"]
    if mode == "modifier":
        return any(0xffe1 in state["mapping"][key - 8] or 0xffe2 in state["mapping"][key - 8] for key in state["keys"])
    return bool(state["keys"])


async def observe_repeat(keys):
    deadline = time.monotonic() + 3
    path = Path("/run/kaguya-app/session/gui-key-events.json")
    while True:
        events = json.loads(path.read_text())
        if events["uid"] == 1001 and events["presses"] >= 2 and any(key in events["held"] for key in keys):
            return events
        if time.monotonic() >= deadline:
            raise RuntimeError("real-auto-repeat-not-observed:" + json.dumps(events))
        await asyncio.sleep(.001)


async def main():
    mode = sys.argv[1]
    if mode not in MODES or os.getuid() != 1000:
        raise RuntimeError("interrupt-probe-denied")
    barrier = InputBarrier(f"/tmp/.X11-unix/X{MODES[mode]}")
    x, _, display = x11.open_x11()
    stdin_transport = None
    pid, identity = None, None
    frozen_group = False
    try:
        x.XQueryExtension.argtypes = [C.c_void_p, C.c_char_p, C.POINTER(C.c_int), C.POINTER(C.c_int), C.POINTER(C.c_int)]
        opcode, event, error = C.c_int(), C.c_int(), C.c_int()
        if not x.XQueryExtension(display, b"XTEST", C.byref(opcode), C.byref(event), C.byref(error)):
            raise RuntimeError("xtest-extension-missing")
        await barrier.start()
        print("proxy-ready", flush=True)
        reader = asyncio.StreamReader(limit=4096)
        stdin_transport, _ = await asyncio.get_running_loop().connect_read_pipe(
            lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer)
        request = json.loads(await asyncio.wait_for(reader.readline(), 120))
        pid = request["pid"]
        if type(pid) is not int or pid < 2:
            raise RuntimeError("interrupt-probe-denied")
        identity = process_stat(Path(f"/proc/{pid}/stat"))[2]
        validate(pid, identity)

        def check_peer(connection):
            peer_pid, uid, _ = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if peer_pid != pid or uid != 1000:
                raise RuntimeError("fixture-x11-peer-denied")
            validate(pid, identity)

        barrier.authorize(check_peer)
        if json.loads(await asyncio.wait_for(reader.readline(), 120)) != {"arm": True}:
            raise RuntimeError("interrupt-arm-request-invalid")
        before = x11.snapshot(x, display)
        if before["keys"] or before["buttons"]:
            raise RuntimeError("input-baseline-not-released")
        symbols = {0xffe1, 0xffe2} if mode == "modifier" else {ord("a")}
        keys = {index + 8 for index, row in enumerate(before["mapping"]) if symbols.intersection(row)}
        barrier.match = lambda packet, order: matches_request(packet, order, opcode.value, mode, keys)
        print("ready", flush=True)
        hit = asyncio.create_task(barrier.hit.wait())
        try:
            done, _ = await asyncio.wait([hit, barrier.failure], timeout=15, return_when=asyncio.FIRST_COMPLETED)
            if barrier.failure in done:
                raise barrier.failure.result()
            if hit not in done:
                raise RuntimeError("input-interruption-request-not-observed:" + mode)
        finally:
            hit.cancel()
            await asyncio.gather(hit, return_exceptions=True)
        # 代理已阻塞后续请求；真实 X server 的处理仍用条件确认，不能把 socket write 当应用成功。
        deadline = time.monotonic() + 3
        while not matches(x11.snapshot(x, display), mode):
            if time.monotonic() >= deadline:
                raise RuntimeError("input-interruption-state-not-observed:" + mode)
            await asyncio.sleep(.001)
        validate(pid, identity)
        os.killpg(pid, signal.SIGSTOP)
        frozen_group = True
        stopped = await stopped_group(pid, identity, time.monotonic() + 2)
        frozen = x11.snapshot(x, display)
        if not matches(frozen, mode):
            raise RuntimeError("input-state-ended-before-freeze")
        repeat = await observe_repeat(frozen["keys"]) if mode == "held" else None
        if barrier.failure.done():
            raise barrier.failure.result()
        print(json.dumps({"mode": mode, "observed": frozen, "autoRepeat": repeat,
                          "barrier": "forwarded-real-request-blocked-successors", "stoppedThreads": stopped,
                          "requestOpcode": barrier.forwarded_target[0]}), flush=True)
    finally:
        primary = sys.exc_info()[1]
        cleanup_errors = []
        try:
            if frozen_group:
                validate(pid, identity)
                os.killpg(pid, signal.SIGKILL)
        except Exception as error:
            cleanup_errors.append(error)
        try:
            if stdin_transport is not None:
                stdin_transport.close()
        except Exception as error:
            cleanup_errors.append(error)
        try:
            await asyncio.wait_for(barrier.close(), 5)
        except Exception as error:
            cleanup_errors.append(error)
        try:
            x.XCloseDisplay(display)
        except Exception as error:
            cleanup_errors.append(error)
        if cleanup_errors:
            raise BaseExceptionGroup("interrupt fixture cleanup failed", ([primary] if primary else []) + cleanup_errors)


if __name__ == "__main__":
    asyncio.run(main())
