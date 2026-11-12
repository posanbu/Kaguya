"""功能概述：真实 Unix socket 验证 CI X11 屏障的分帧、身份准入与关闭行为。
主要职责：BarrierTest 验证分帧、FD 回收、单次目标与后继阻塞；SetupCleanupTest 注入 setup 失败，StopTest 验证停止身份。
代码库关系：调用 gui_input_barrier 的实际代理；主 Linux GUI fixture 另验证固定 Cua 与真实 X server。
输入输出与副作用：仅临时 socket/FD 与内存数据；有界全资源清理，仅已声明拒绝且 FD 已关闭的 ECONNRESET 是预期终态。
"""
import asyncio
import importlib.util
import os
import socket
from pathlib import Path
import struct
import tempfile
import unittest
import warnings
from unittest.mock import AsyncMock, patch
import gui_input_barrier as barrier_module
from gui_input_barrier import InputBarrier, RawReader, send_packet, read_reply, matches_request, read_request, read_setup


def setup(order):
    header = bytearray(12)
    header[0] = ord("l") if order == "<" else ord("B")
    struct.pack_into(order + "HHHH", header, 2, 11, 0, 3, 5)
    return bytes(header) + b"MIT\0token\0\0\0"


def event(order, kind, detail, opcode=132):
    return bytes([opcode, 2]) + struct.pack(order + "H", 9) + bytes([kind, detail]) + bytes(30)


def setup_reply(order):
    return bytes([1, 0]) + struct.pack(order + "HHH", 11, 0, 0)


def reply(order, fds=0):
    return bytes([1, fds]) + struct.pack(order + "HI", 1, 0) + bytes(24)


class BarrierTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="x11-")
        self.addCleanup(self.directory.cleanup)
        self.records, self.tasks, self.clients, self.server_writers, self.raw_clients = [], [], [], [], []
        self.fd_response = None
        self.expected_resets = set()
        self.backend, self.barrier = None, None
        # 在获得第一个 socket 前登记，asyncSetUp 中途失败也执行同一完整清理。
        self.addAsyncCleanup(self.close)
        self.received = asyncio.Queue()
        self.backend = await asyncio.start_unix_server(self.accept, path=self.directory.name + "/real")
        self.barrier = InputBarrier(self.directory.name + "/proxy", self.directory.name + "/real")
        await self.barrier.start()
        self.barrier.authorize(lambda _: None)

    def accept(self, reader, writer):
        self.server_writers.append(writer)
        async def serve():
            record = []
            self.records.append(record)
            try:
                initial, order = await read_setup(reader)
                record.append(initial)
                writer.write(setup_reply(order))
                await writer.drain()
                while True:
                    packet = await read_request(reader, order)
                    record.append(packet)
                    self.received.put_nowait(packet)
                    if self.fd_response is None:
                        writer.write(reply(order))
                        await writer.drain()
                    else:
                        raw = writer.get_extra_info("socket").dup()
                        try:
                            await send_packet(raw, reply(order, 1), [os.dup(self.fd_response)])
                        finally:
                            raw.close()
            except (asyncio.IncompleteReadError, ConnectionError):
                pass
            finally:
                writer.transport.abort()
                await asyncio.wait_for(writer.wait_closed(), 2)
        self.tasks.append(asyncio.create_task(serve()))

    async def close(self):
        errors = []

        async def attempt(operation):
            try:
                await asyncio.wait_for(operation(), 2)
            except Exception as error:
                errors.append(error)

        async def wait_writer(writer):
            try:
                await writer.wait_closed()
            except ConnectionResetError:
                endpoint = writer.get_extra_info("socket")
                # Linux 拒绝连接会以 ECONNRESET 完成 close；只接受已声明的拒绝且 FD 确实关闭。
                if writer not in self.expected_resets or not writer.is_closing() or (endpoint is not None and endpoint.fileno() != -1):
                    raise

        if self.barrier is not None:
            await attempt(self.barrier.close)
        for writer in self.clients + self.server_writers:
            try:
                writer.transport.abort()
            except Exception as error:
                errors.append(error)
            await attempt(lambda: wait_writer(writer))
        for connection in self.raw_clients:
            try:
                connection.close()
            except Exception as error:
                errors.append(error)
        if self.backend is not None:
            try:
                self.backend.close()
            except Exception as error:
                errors.append(error)
        for task in self.tasks:
            if not task.done():
                task.cancel()

        async def drain():
            results = await asyncio.gather(*self.tasks, return_exceptions=True)
            errors.extend(error for error in results if isinstance(error, Exception))

        await attempt(drain)
        if self.backend is not None:
            await attempt(self.backend.wait_closed)
        if errors:
            raise ExceptionGroup("barrier test cleanup failed", errors)

    async def client(self, order):
        reader, writer = await asyncio.open_unix_connection(str(self.barrier.path))
        self.clients.append(writer)
        # 每次发送一个字节，服务端必须等完整 auth 名称/数据及 padding 后才能转发请求。
        for byte in setup(order):
            writer.write(bytes([byte]))
            await writer.drain()
        self.assertEqual(await asyncio.wait_for(reader.readexactly(8), 2), setup_reply(order))
        return reader, writer

    async def test_little_endian_coalesced_release_and_other_connections_are_blocked(self):
        await self.coalesced("<")

    async def test_big_endian_coalesced_release_and_other_connections_are_blocked(self):
        await self.coalesced(">")

    async def coalesced(self, order):
        reader, writer = await self.client(order)
        _, other = await self.client(order)
        down, release = event(order, 2, 38), event(order, 3, 38)
        self.barrier.match = lambda packet, byte_order: matches_request(packet, byte_order, 132, "held", {38})
        writer.write(down + release)
        await writer.drain()
        await asyncio.wait_for(self.barrier.hit.wait(), 2)
        self.assertEqual(await asyncio.wait_for(self.received.get(), 2), down)
        self.assertEqual(await asyncio.wait_for(reader.readexactly(32), 2), reply(order))
        other.write(release)
        await other.drain()
        await self.close()
        self.assertEqual([p for record in self.records for p in record[1:]], [down])
        self.assertTrue(self.received.empty())
        self.assertEqual(self.barrier.tasks, set())
        self.assertFalse(self.barrier.path.exists())

    async def test_unarmed_packets_and_server_replies_pass_unchanged(self):
        reader, writer = await self.client("<")
        packets = [event("<", 2, 38), event("<", 3, 38)]
        writer.write(b"".join(packets))
        await writer.drain()
        for packet in packets:
            self.assertEqual(await asyncio.wait_for(self.received.get(), 2), packet)
        self.assertEqual(await asyncio.wait_for(reader.readexactly(64), 2), reply("<") * 2)
        self.assertFalse(self.barrier.hit.is_set())

    async def test_shared_memory_fd_reaches_client_with_its_reply(self):
        with tempfile.TemporaryFile() as pixels:
            pixels.write(b"actual shared-memory pixels")
            pixels.seek(0)
            self.fd_response = pixels.fileno()
            connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            connection.setblocking(False)
            self.raw_clients.append(connection)
            await asyncio.wait_for(asyncio.get_running_loop().sock_connect(connection, str(self.barrier.path)), 2)
            reader = RawReader(connection)
            self.addCleanup(lambda: [os.close(fd) for fd in reader.take_fds()])
            await send_packet(connection, setup("<"), [])
            self.assertEqual(await asyncio.wait_for(read_reply(reader, "<", initial=True), 2), setup_reply("<"))
            await send_packet(connection, event("<", 2, 38), [])
            self.assertEqual(await asyncio.wait_for(read_reply(reader, "<"), 2), reply("<", 1))
            descriptors = reader.take_fds()
            try:
                self.assertEqual(len(descriptors), 1)
                self.assertFalse(os.get_inheritable(descriptors[0]))
                self.assertEqual(os.read(descriptors[0], 64), b"actual shared-memory pixels")
            finally:
                for descriptor in descriptors:
                    os.close(descriptor)

    async def test_send_failure_closes_owned_descriptor(self):
        left, right = socket.socketpair()
        self.raw_clients.extend([left, right])
        left.setblocking(False)
        right.close()
        with tempfile.TemporaryFile() as source:
            descriptor = os.dup(source.fileno())
            with self.assertRaises(ConnectionError):
                await send_packet(left, b"x", [descriptor])
            with self.assertRaises(OSError):
                os.fstat(descriptor)

    async def test_cancelled_send_closes_owned_descriptor(self):
        waiting = asyncio.Event()

        async def blocked(*_args, **_kwargs):
            waiting.set()
            await asyncio.Future()

        class FullSocket:
            def sendmsg(self, *_args):
                raise BlockingIOError()

        with tempfile.TemporaryFile() as source:
            descriptor = os.dup(source.fileno())
            with patch.object(barrier_module, "socket_ready", blocked):
                task = asyncio.create_task(send_packet(FullSocket(), b"x", [descriptor]))
                try:
                    await asyncio.wait_for(waiting.wait(), 2)
                finally:
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
            with self.assertRaises(OSError):
                os.fstat(descriptor)

    async def test_truncated_ancillary_closes_all_received_descriptors(self):
        left, right = socket.socketpair()
        self.raw_clients.extend([left, right])
        left.setblocking(False)
        right.setblocking(False)
        with tempfile.TemporaryFile() as source:
            await send_packet(left, b"x", [os.dup(source.fileno()) for _ in range(17)])
        reader = RawReader(right)
        with patch.object(barrier_module.os, "close", wraps=os.close) as closed, warnings.catch_warnings():
            warnings.filterwarnings("ignore", message="received malformed or improperly-truncated ancillary data", category=RuntimeWarning)
            with self.assertRaisesRegex(RuntimeError, "invalid-x11-ancillary-data"):
                await asyncio.wait_for(reader.readexactly(1), 2)
        self.assertFalse(reader.fds)
        self.assertGreater(len(closed.call_args_list), 0)
        for call in closed.call_args_list:
            with self.assertRaises(OSError):
                os.fstat(call.args[0])

    async def test_request_fd_and_partial_send_keep_one_descriptor_transfer(self):
        left, right = socket.socketpair()
        self.raw_clients.extend([left, right])
        left.setblocking(False)
        right.setblocking(False)
        with tempfile.TemporaryFile() as source:
            source.write(b"request shared memory")
            source.seek(0)
            await send_packet(left, event("<", 2, 38), [os.dup(source.fileno())])
            reader = RawReader(right)
            self.assertEqual(await asyncio.wait_for(read_request(reader, "<"), 2), event("<", 2, 38))
            descriptors = reader.take_fds()
            try:
                self.assertEqual(len(descriptors), 1)
                self.assertEqual(os.read(descriptors[0], 64), b"request shared memory")
            finally:
                for descriptor in descriptors:
                    os.close(descriptor)
            transferred = []

            class PartialSocket:
                def sendmsg(self, buffers, ancillary):
                    transferred.append((bytes(buffers[0][:1]), bool(ancillary)))
                    return 1

            await send_packet(PartialSocket(), b"abc", [os.dup(source.fileno())])
            self.assertEqual(transferred, [(b"a", True), (b"b", False), (b"c", False)])

    async def test_proxy_close_reclaims_fd_from_an_incomplete_request(self):
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.setblocking(False)
        self.raw_clients.append(connection)
        await asyncio.wait_for(asyncio.get_running_loop().sock_connect(connection, str(self.barrier.path)), 2)
        reader = RawReader(connection)
        await send_packet(connection, setup("<"), [])
        await asyncio.wait_for(read_reply(reader, "<", initial=True), 2)
        owned = []
        received = asyncio.Event()
        original = os.set_inheritable

        def track(descriptor, value):
            original(descriptor, value)
            owned.append(descriptor)
            received.set()

        with tempfile.TemporaryFile() as source, patch.object(barrier_module.os, "set_inheritable", track):
            await send_packet(connection, event("<", 2, 38)[:2], [os.dup(source.fileno())])
            await asyncio.wait_for(received.wait(), 2)
            await self.close()
        self.assertTrue(owned)
        for descriptor in owned:
            with self.assertRaises(OSError):
                os.fstat(descriptor)

    async def test_cleanup_failure_still_closes_clients_backend_and_workers(self):
        await self.client("<")
        close = self.barrier.close
        error = OSError("injected proxy cleanup failure")

        async def fail():
            await close()
            raise error

        with patch.object(self.barrier, "close", fail):
            with self.assertRaises(ExceptionGroup) as result:
                await self.close()
        self.assertIn(error, result.exception.exceptions)
        self.assertFalse(self.backend.is_serving())
        self.assertTrue(all(writer.is_closing() for writer in self.clients + self.server_writers))
        self.assertTrue(all(task.done() for task in self.tasks))

    async def test_only_declared_rejection_accepts_reset_of_a_closed_socket(self):
        _, writer = await self.client("<")
        reset = ConnectionResetError("injected peer reset")
        with patch.object(writer, "wait_closed", AsyncMock(side_effect=reset)):
            with self.assertRaises(ExceptionGroup) as result:
                await self.close()
            self.assertIn(reset, result.exception.exceptions)
            self.expected_resets.add(writer)
            await self.close()
        self.assertEqual(writer.get_extra_info("socket").fileno(), -1)
        self.assertFalse(self.backend.is_serving())

    async def test_peer_denial_and_invalid_frames_fail_closed(self):
        self.barrier.authorize(lambda _: (_ for _ in ()).throw(RuntimeError("peer-denied")))
        _, writer = await asyncio.open_unix_connection(str(self.barrier.path))
        self.clients.append(writer)
        self.expected_resets.add(writer)
        writer.write(setup("<"))
        await writer.drain()
        error = await asyncio.wait_for(self.barrier.failure, 2)
        self.assertEqual(str(error), "peer-denied")
        self.assertEqual(self.records, [])

    async def test_fragmented_big_request_and_invalid_length(self):
        packet = bytes([132, 2, 0, 0]) + struct.pack("<I", 10) + bytes([2, 38]) + bytes(30)
        reader = asyncio.StreamReader()
        for byte in packet:
            reader.feed_data(bytes([byte]))
        self.assertEqual(await read_request(reader, "<"), packet)
        self.assertTrue(matches_request(packet, "<", 132, "held", {38}))
        for length in (1, 0x10000000):
            reader = asyncio.StreamReader()
            reader.feed_data(bytes([132, 2, 0, 0]) + struct.pack("<I", length))
            with self.assertRaisesRegex(RuntimeError, "invalid-x11-request-length"):
                await read_request(reader, "<")

    async def test_invalid_handshake_fails_closed_without_forwarding_auth(self):
        _, writer = await asyncio.open_unix_connection(str(self.barrier.path))
        self.clients.append(writer)
        self.expected_resets.add(writer)
        writer.write(b"?" + setup("<")[1:])
        await writer.drain()
        error = await asyncio.wait_for(self.barrier.failure, 2)
        self.assertEqual(str(error), "invalid-x11-byte-order")
        await self.close()
        self.assertEqual([packet for record in self.records for packet in record], [])

    async def test_incomplete_handshake_is_closed_without_waiting_for_more_bytes(self):
        _, writer = await asyncio.open_unix_connection(str(self.barrier.path))
        self.clients.append(writer)
        writer.write(setup("<")[:8])
        await writer.drain()
        await self.close()
        self.assertFalse(self.barrier.tasks)
        self.assertEqual([packet for record in self.records for packet in record], [])

    async def test_only_exact_target_event_or_unicode_mapping_matches(self):
        for order in ("<", ">"):
            for mode, key, kind in (("held", 38, 2), ("modifier", 50, 2), ("button", 1, 4)):
                self.assertTrue(matches_request(event(order, kind, key), order, 132, mode, {key}))
                self.assertFalse(matches_request(event(order, kind + 1, key), order, 132, mode, {key}))
                self.assertFalse(matches_request(event(order, kind, key, 131), order, 132, mode, {key}))
            packet = bytes([100, 1]) + struct.pack(order + "H", 3) + bytes([248, 1, 0, 0]) + struct.pack(order + "I", 0x1004e2d)
            self.assertTrue(matches_request(packet, order, 132, "unicode", set()))
            self.assertFalse(matches_request(packet[:-4] + bytes(4), order, 132, "unicode", set()))


class SetupCleanupTest(unittest.TestCase):
    def test_setup_failure_runs_registered_resource_cleanup(self):
        original = InputBarrier.start

        async def fail(barrier):
            await original(barrier)
            raise OSError("injected setup failure")

        case = BarrierTest("test_unarmed_packets_and_server_replies_pass_unchanged")
        result = unittest.TestResult()
        with patch.object(InputBarrier, "start", fail):
            case.run(result)
        self.assertEqual(len(result.errors), 1)
        self.assertIn("injected setup failure", result.errors[0][1])
        self.assertFalse(case.backend.is_serving())
        self.assertFalse(case.barrier.tasks)
        self.assertTrue(case.barrier.accept_task.done())
        self.assertFalse(Path(case.directory.name).exists())


class StopTest(unittest.IsolatedAsyncioTestCase):
    async def test_stop_requires_stable_thread_identity_and_all_threads_stopped(self):
        spec = importlib.util.spec_from_file_location("interrupt", Path(__file__).with_name("gui-interrupt-probe.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        states = [{"2/2": ("R", "10")}, {"2/2": ("T", "10")},
                  {"2/2": ("T", "10"), "2/3": ("R", "11")},
                  {"2/2": ("T", "10"), "2/3": ("T", "11")}]
        states.append(states[-1])
        with patch.object(module, "validate"), patch.object(module, "group_threads", side_effect=states):
            self.assertEqual(await module.stopped_group(2, "10", module.time.monotonic() + 2), states[-1])
        with patch.object(module, "validate"), patch.object(module, "group_threads", return_value={"2/2": ("R", "10")}):
            with self.assertRaisesRegex(RuntimeError, "stop-unconfirmed"):
                await module.stopped_group(2, "10", module.time.monotonic())


if __name__ == "__main__":
    unittest.main()
