"""功能概述：验证 X11 收尾只恢复本次可归属的空键位，且未知映射/held 状态不能成功确认。
代码库关系：导入 gui-x11.py 的纯收尾逻辑；真实 XServer/Cua 反例另由 Linux GUI fixture 验证。
输入输出与副作用：使用显式前后状态与假的 X 函数，不加载 X11 动态库、不修改本机输入。
"""
import copy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("gui_x11", Path(__file__).with_name("gui-x11.py"))
gui = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gui)


class ResetTests(unittest.TestCase):
    def baseline(self):
        rows = [[0, 0] for _ in range(248)]
        rows[20] = [97, 65]
        return {"keys": [], "buttons": [], "mapping": rows, "per": 2}

    def test_release_and_restore_only_borrowed_slot(self):
        before = self.baseline()
        current = copy.deepcopy(before)
        current["keys"], current["buttons"] = [50, 254], [1]
        current["mapping"][246] = [0x1004e2d] * 2
        # 应用在原非空键位作出的布局变化不是 Driver 空槽借用，不得重置。
        current["mapping"][20] = [98, 66]
        after = copy.deepcopy(current)
        after["keys"], after["buttons"] = [], []
        after["mapping"][246] = [0, 0]
        x, xt = Mock(), Mock()
        with patch.object(gui, "snapshot", side_effect=[current, after]):
            result = gui.reset(x, xt, "display", before, {0x1004e2d})
        self.assertEqual(result["restoredKeycodes"], [254])
        self.assertEqual(x.XChangeKeyboardMapping.call_count, 1)
        self.assertEqual(x.XChangeKeyboardMapping.call_args.args[1], 254)
        self.assertEqual(xt.XTestFakeKeyEvent.call_count, 2)
        xt.XTestFakeButtonEvent.assert_called_once_with("display", 1, 0, 0)
        x.XSync.assert_called_once_with("display", 0)

    def test_unattributed_empty_slot_change_is_preserved_and_unconfirmed(self):
        before = self.baseline()
        current = copy.deepcopy(before)
        current["mapping"][245] = [1234, 1234]
        x = Mock()
        with patch.object(gui, "snapshot", side_effect=[current, current]):
            with self.assertRaisesRegex(RuntimeError, "reset-unconfirmed"):
                gui.reset(x, Mock(), "display", before, {0x1004e2d})
        x.XChangeKeyboardMapping.assert_not_called()

    def test_round_trip_does_not_replace_held_state_readback(self):
        before = self.baseline()
        current = copy.deepcopy(before)
        current["keys"] = [50]
        with patch.object(gui, "snapshot", side_effect=[current, current]):
            with self.assertRaisesRegex(RuntimeError, "reset-unconfirmed"):
                gui.reset(Mock(), Mock(), "display", before, set())

    def test_partial_row_is_not_attributed_to_cua(self):
        before = self.baseline()
        current = copy.deepcopy(before)
        current["mapping"][245] = [0x1004e2d, 0]
        x = Mock()
        with patch.object(gui, "snapshot", side_effect=[current, current]):
            with self.assertRaisesRegex(RuntimeError, "reset-unconfirmed"):
                gui.reset(x, Mock(), "display", before, {0x1004e2d})
        x.XChangeKeyboardMapping.assert_not_called()

    def test_fixed_xvfb_unicode_normalization_matches_complete_row(self):
        before = {"keys": [], "buttons": [], "per": 7, "mapping": [[0] * 7 for _ in range(248)]}
        current = copy.deepcopy(before)
        current["mapping"][240] = [0x1004e2d] * 4 + [0] * 3
        x = Mock()
        with patch.object(gui, "snapshot", side_effect=[current, before]):
            result = gui.reset(x, Mock(), "display", before, {0x1004e2d})
        self.assertEqual(result["restoredKeycodes"], [248])
        for row in ([0x1004e2d, 0, 0x1004e2d, 0, 0, 0, 0], [0x1004e2d] * 5 + [0] * 2):
            current["mapping"][240] = row
            x.reset_mock()
            with patch.object(gui, "snapshot", side_effect=[current, current]):
                with self.assertRaisesRegex(RuntimeError, "reset-unconfirmed"):
                    gui.reset(x, Mock(), "display", before, {0x1004e2d})
            x.XChangeKeyboardMapping.assert_not_called()


if __name__ == "__main__":
    unittest.main()
