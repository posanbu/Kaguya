#!/usr/bin/env python3
"""功能概述：可信 UID 的固定 X11 输入状态读取与收尾，不运行任意命令或访问宿主 display。
主要职责：snapshot 保存键盘映射/held 状态；reset 在 Driver 组退出后释放 key/button，
仅恢复本次输入可借用的原空 keycode，XSync 后读回，异常不签发成功。
代码库关系：GUI component 经私有 stdin 调用；仅 :99、本容器 XTest，不需要 uinput/capability。
输入输出与副作用：JSON 最大 256KiB；不重置用户非空键位。未知空槽映射改变保留并拒绝确认。
"""
import ctypes as C
import json
import os
import sys


def open_x11():
    if os.getuid() != 1000:
        raise RuntimeError("gui-control-uid-required")
    x = C.CDLL("libX11.so.6")
    xt = C.CDLL("libXtst.so.6")
    display_type = C.c_void_p
    x.XOpenDisplay.argtypes, x.XOpenDisplay.restype = [C.c_char_p], display_type
    x.XCloseDisplay.argtypes = [display_type]
    x.XDefaultRootWindow.argtypes, x.XDefaultRootWindow.restype = [display_type], C.c_ulong
    x.XQueryKeymap.argtypes = [display_type, C.c_void_p]
    x.XQueryPointer.argtypes = [display_type, C.c_ulong, C.POINTER(C.c_ulong), C.POINTER(C.c_ulong),
                               C.POINTER(C.c_int), C.POINTER(C.c_int), C.POINTER(C.c_int), C.POINTER(C.c_int), C.POINTER(C.c_uint)]
    x.XGetKeyboardMapping.argtypes = [display_type, C.c_ubyte, C.c_int, C.POINTER(C.c_int)]
    x.XGetKeyboardMapping.restype = C.POINTER(C.c_ulong)
    x.XChangeKeyboardMapping.argtypes = [display_type, C.c_int, C.c_int, C.POINTER(C.c_ulong), C.c_int]
    x.XFree.argtypes = [C.c_void_p]
    x.XSync.argtypes = [display_type, C.c_int]
    xt.XTestFakeKeyEvent.argtypes = [display_type, C.c_uint, C.c_int, C.c_ulong]
    xt.XTestFakeButtonEvent.argtypes = [display_type, C.c_uint, C.c_int, C.c_ulong]
    d = x.XOpenDisplay(b":99")
    if not d:
        raise RuntimeError("gui-display-unavailable")
    return x, xt, d


def snapshot(x, d):
    keymap = (C.c_ubyte * 32)()
    x.XQueryKeymap(d, keymap)
    held = [code for code in range(8, 256) if keymap[code // 8] & (1 << (code % 8))]
    root, child = C.c_ulong(), C.c_ulong()
    rx, ry, wx, wy = C.c_int(), C.c_int(), C.c_int(), C.c_int()
    mask = C.c_uint()
    if not x.XQueryPointer(d, x.XDefaultRootWindow(d), C.byref(root), C.byref(child),
                          C.byref(rx), C.byref(ry), C.byref(wx), C.byref(wy), C.byref(mask)):
        raise RuntimeError("gui-pointer-state-unconfirmed")
    per = C.c_int()
    mapping = x.XGetKeyboardMapping(d, 8, 248, C.byref(per))
    if not mapping or not 1 <= per.value <= 32:
        raise RuntimeError("gui-keyboard-map-unconfirmed")
    try:
        rows = [list(mapping[i * per.value:(i + 1) * per.value]) for i in range(248)]
    finally:
        x.XFree(mapping)
    return {"keys": held, "buttons": [button for button in range(1, 6) if mask.value & (1 << (button + 7))],
            "mapping": rows, "per": per.value}


def reset(x, xt, d, before, expected_keysyms):
    if not isinstance(before, dict) or len(before.get("mapping", [])) != 248 or not 1 <= before.get("per", 0) <= 32:
        raise RuntimeError("invalid-keyboard-baseline")
    if any(len(row) != before["per"] or any(type(v) is not int or not 0 <= v <= 0xffffffff for v in row) for row in before["mapping"]):
        raise RuntimeError("invalid-keyboard-baseline")
    current = snapshot(x, d)
    for code in current["keys"]:
        if not xt.XTestFakeKeyEvent(d, code, 0, 0):
            raise RuntimeError("gui-key-release-failed")
    for button in current["buttons"]:
        if not xt.XTestFakeButtonEvent(d, button, 0, 0):
            raise RuntimeError("gui-button-release-failed")
    restore = []
    unexpected = []
    for index, original in enumerate(before["mapping"]):
        now = current["mapping"][index]
        if any(original) or not any(now):
            continue
        # Cua 仅借全空槽。固定 Xvfb 21.1.12 的 core mapping 会把 Unicode 行
        # 规范化为前四列同符号、后三列零（真实 79db69c keycode248 证据）。
        # 按完整行匹配两种已知形状；不能丢弃零后仅比较非零 symbols。
        exact = any(now == [symbol] * len(now) for symbol in expected_keysyms)
        normalized = before["per"] == 7 and any(
            0x01000000 <= symbol <= 0x0110ffff and now == [symbol] * 4 + [0] * 3
            for symbol in expected_keysyms)
        if not exact and not normalized:
            unexpected.append({"keycode": index + 8, "mapping": now})
            continue
        array = (C.c_ulong * before["per"])(*original)
        x.XChangeKeyboardMapping(d, index + 8, before["per"], array, 1)
        restore.append(index)
    x.XSync(d, 0)
    after = snapshot(x, d)
    if after["keys"] or after["buttons"] or any(any(after["mapping"][i]) for i in restore) or unexpected:
        raise RuntimeError("gui-input-reset-unconfirmed:" + json.dumps({
            "keysBefore": current["keys"], "buttonsBefore": current["buttons"],
            "keysAfter": after["keys"], "buttonsAfter": after["buttons"],
            "restoredKeycodes": [i + 8 for i in restore], "unexpectedMappings": unexpected,
            "unrestoredMappings": [{"keycode": i + 8, "mapping": after["mapping"][i]} for i in restore if any(after["mapping"][i])],
        }))
    return {"keys": [], "buttons": [], "restoredKeycodes": [i + 8 for i in restore], "roundTrip": True}


def main():
    raw = sys.stdin.buffer.read(262145)
    if len(raw) > 262144:
        raise RuntimeError("x11-request-limit")
    request = json.loads(raw)
    x, xt, d = open_x11()
    try:
        if request == {"mode": "snapshot"}:
            result = snapshot(x, d)
        elif set(request) == {"mode", "before", "expectedKeysyms"} and request["mode"] == "reset":
            symbols = request["expectedKeysyms"]
            if not isinstance(symbols, list) or len(symbols) > 4096 or any(type(v) is not int or not 0 <= v <= 0xffffffff for v in symbols):
                raise RuntimeError("invalid-keysyms")
            result = reset(x, xt, d, request["before"], set(symbols))
        else:
            raise RuntimeError("x11-operation-denied")
        print(json.dumps(result))
    finally:
        x.XCloseDisplay(d)


if __name__ == "__main__":
    main()
