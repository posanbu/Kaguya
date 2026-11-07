#!/usr/bin/env python3
"""功能概述：只读列出固定 X11 桌面中已映射的 POPUP_MENU，作为 Openbox 菜单就绪屏障。
主要职责：查询根窗口子窗口的 EWMH 类型和真实 Map State，不抢占键盘、不派发输入。
代码库关系：gui-launch-probe.mjs 在一次 Alt-F9 后轮询；固定 Openbox 在取得输入 grab 后才映射菜单。
输入输出与副作用：不接受 argv；只输出窗口 id，使用 gui-x11.py 的 UID1000/:99 边界。
"""
import importlib.util
import json
from pathlib import Path
import subprocess

spec = importlib.util.spec_from_file_location("gui_x11", Path(__file__).with_name("gui-x11.py"))
gui = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gui)
C = gui.C
x, _, display = gui.open_x11()
class XError(C.Structure):
    _fields_ = [("type", C.c_int), ("display", C.c_void_p), ("resourceid", C.c_ulong), ("serial", C.c_ulong),
                ("error_code", C.c_ubyte), ("request_code", C.c_ubyte), ("minor_code", C.c_ubyte)]
errors = []
handler_type = C.CFUNCTYPE(C.c_int, C.c_void_p, C.POINTER(XError))
@handler_type
def on_error(_display, event):
    # 枚举与读取间窗口可能被应用销毁；BadWindow 是观察失效，其余协议错误保留失败。
    if event.contents.error_code != 3:
        errors.append(int(event.contents.error_code))
    return 0
x.XSetErrorHandler.argtypes = [handler_type]
x.XSetErrorHandler(on_error)
x.XInternAtom.argtypes, x.XInternAtom.restype = [C.c_void_p, C.c_char_p, C.c_int], C.c_ulong
x.XQueryTree.argtypes = [C.c_void_p, C.c_ulong, C.POINTER(C.c_ulong), C.POINTER(C.c_ulong), C.POINTER(C.POINTER(C.c_ulong)), C.POINTER(C.c_uint)]
x.XGetWindowProperty.argtypes = [C.c_void_p, C.c_ulong, C.c_ulong, C.c_long, C.c_long, C.c_int, C.c_ulong,
                                C.POINTER(C.c_ulong), C.POINTER(C.c_int), C.POINTER(C.c_ulong), C.POINTER(C.c_ulong), C.POINTER(C.POINTER(C.c_ubyte))]
try:
    kind = x.XInternAtom(display, b"_NET_WM_WINDOW_TYPE", 1)
    popup = x.XInternAtom(display, b"_NET_WM_WINDOW_TYPE_POPUP_MENU", 1)
    root, parent, count = C.c_ulong(), C.c_ulong(), C.c_uint()
    children = C.POINTER(C.c_ulong)()
    if not x.XQueryTree(display, x.XDefaultRootWindow(display), C.byref(root), C.byref(parent), C.byref(children), C.byref(count)):
        raise RuntimeError("menu-tree-unconfirmed")
    found = []
    try:
        for window in children[:count.value]:
            actual, items, remaining = C.c_ulong(), C.c_ulong(), C.c_ulong()
            form = C.c_int()
            value = C.POINTER(C.c_ubyte)()
            status = x.XGetWindowProperty(display, window, kind, 0, 8, 0, 0, C.byref(actual), C.byref(form), C.byref(items), C.byref(remaining), C.byref(value))
            try:
                if status != 0 or form.value != 32 or not value or popup not in C.cast(value, C.POINTER(C.c_ulong))[:items.value]:
                    continue
                state = subprocess.run(["/usr/bin/xwininfo", "-id", str(window)], env={"DISPLAY": ":99"}, capture_output=True, timeout=2)
                if state.returncode == 0 and b"Map State: IsViewable" in state.stdout:
                    found.append(window)
            finally:
                if value:
                    x.XFree(value)
    finally:
        if children:
            x.XFree(children)
    x.XSync(display, 0)
    if errors:
        raise RuntimeError(f"menu-query-unconfirmed:{errors}")
    print(json.dumps({"mappedPopupWindows": found}))
finally:
    x.XCloseDisplay(display)
