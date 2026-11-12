#!/usr/bin/env python3
"""功能概述：Linux CI 的真实 GTK 合成窗口，作为截图/AX/输入的独立应用证据。
主要职责：提供未保存文本框和计数按钮；独立键盘窗口记录真实按下/释放及 auto-repeat。
代码库关系：check-gui-container.py 仅以 UID1001 启动；不访问控制 socket 或模型。
输入输出与副作用：固定合成内容写 /home/app/session/gui-ledger.json，窗口关闭退出。
"""
import json
import os
from pathlib import Path
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk

if os.getuid() != 1001:
    raise RuntimeError("fixture-app-uid-required")
window = Gtk.Window(title="Kaguya GUI acceptance")
window.set_default_size(600, 300)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=20)
window.add(box)
entry = Gtk.Entry()
entry.get_accessible().set_name("Unsaved text")
button = Gtk.Button(label="Increment once")
count = 0


def save(*_args):
    path = Path("/home/app/session/gui-ledger.json")
    pending = path.with_suffix(".pending")
    with pending.open("w") as stream:
        json.dump({"uid": os.getuid(), "pid": os.getpid(), "text": entry.get_text(), "count": count}, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(pending, path)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def increment(_button):
    global count
    count += 1
    save()


entry.connect("changed", save)
button.connect("clicked", increment)
box.pack_start(entry, False, False, 0)
box.pack_start(button, False, False, 0)
window.connect("destroy", Gtk.main_quit)
window.show_all()
save()
keyboard_window = Gtk.Window(title="Kaguya keyboard acceptance")
keyboard_window.set_default_size(400, 180)
area = Gtk.DrawingArea()
area.set_can_focus(True)
area.add_events(Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.KEY_PRESS_MASK | Gdk.EventMask.KEY_RELEASE_MASK)
area.connect("button-press-event", lambda *_: area.grab_focus())
keyboard_window.add(area)
pressed = set()
presses, releases = 0, 0


def key_event(_area=None, event=None):
    global presses, releases
    if event is not None:
        if event.type == Gdk.EventType.KEY_PRESS:
            presses += 1
            pressed.add(event.hardware_keycode)
        else:
            releases += 1
            pressed.discard(event.hardware_keycode)
    path = Path("/run/kaguya-app/session/gui-key-events.json")
    pending = path.with_suffix(".pending")
    with pending.open("w") as stream:
        json.dump({"uid": os.getuid(), "pid": os.getpid(), "presses": presses, "releases": releases, "held": sorted(pressed)}, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(pending, 0o644)
    os.replace(pending, path)
    return True


area.connect("key-press-event", key_event)
area.connect("key-release-event", key_event)
keyboard_window.show_all()
key_event()
Gtk.main()
