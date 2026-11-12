"""功能概述：仅供 drain 验收的 X11 请求屏障，转发真实 Cua 数据，不生成输入。
主要职责：RawReader/send_packet 同步转发帧与 SCM_RIGHTS；InputBarrier 同步登记 accepted socket，在目标请求后封闭后续请求。
代码库关系：gui-interrupt-probe.py 注入目标匹配器，在屏障后验证真实 X11 状态并停止驱动。
输入输出与副作用：独立 Unix socket 代理 :99；MIT-SHM 截图 FD 随对应回复转发，失败/关闭时回收本地 FD 与 socket。
"""
import asyncio
import array
import os
from pathlib import Path
import socket
import struct


def close_fds(descriptors):
    for descriptor in descriptors:
        os.close(descriptor)
    descriptors.clear()


async def socket_ready(connection, *, writing=False):
    loop = asyncio.get_running_loop()
    ready = loop.create_future()
    descriptor = connection.fileno()
    def wake():
        if not ready.done():
            ready.set_result(None)
    register = loop.add_writer if writing else loop.add_reader
    remove = loop.remove_writer if writing else loop.remove_reader
    register(descriptor, wake)
    try:
        await ready
    finally:
        remove(descriptor)


class RawReader:
    """每帧最多 16 个 FD；精确读取字节数使 ancillary 留在所属请求/回复帧。"""
    def __init__(self, connection):
        self.connection = connection
        self.fds = []

    async def readexactly(self, size):
        chunks = bytearray()
        while len(chunks) < size:
            try:
                data, ancillary, flags, _ = self.connection.recvmsg(
                    size - len(chunks), socket.CMSG_SPACE(16 * array.array("i").itemsize),
                    getattr(socket, "MSG_CMSG_CLOEXEC", 0))
            except BlockingIOError:
                await socket_ready(self.connection)
                continue
            unknown = False
            for level, kind, payload in ancillary:
                if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                    descriptors = array.array("i")
                    descriptors.frombytes(payload[:len(payload) - len(payload) % descriptors.itemsize])
                    self.fds.extend(descriptors)
                    unknown |= len(payload) % descriptors.itemsize != 0
                else:
                    unknown = True
            if unknown or flags & socket.MSG_CTRUNC or len(self.fds) > 16:
                close_fds(self.fds)
                raise RuntimeError("invalid-x11-ancillary-data")
            for descriptor in self.fds:
                os.set_inheritable(descriptor, False)
            if not data:
                raise asyncio.IncompleteReadError(bytes(chunks), size)
            chunks.extend(data)
        return bytes(chunks)

    def take_fds(self):
        descriptors, self.fds = self.fds, []
        return descriptors


async def send_packet(connection, packet, descriptors):
    """接管 descriptors；sendmsg 成功、失败或取消后均关闭代理持有的副本。"""
    try:
        view = memoryview(packet)
        while view:
            try:
                ancillary = [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", descriptors))] if descriptors else []
                count = connection.sendmsg([view], ancillary)
            except BlockingIOError:
                await socket_ready(connection, writing=True)
                continue
            if count <= 0:
                raise ConnectionError("x11-forward-closed")
            close_fds(descriptors)
            view = view[count:]
    finally:
        close_fds(descriptors)


async def read_reply(reader, order, *, initial=False):
    header = await reader.readexactly(8 if initial else 32)
    if initial:
        if header[0] not in (0, 1, 2):
            raise RuntimeError("invalid-x11-setup-response")
        length = struct.unpack_from(order + "H", header, 6)[0] * 4
    else:
        length = struct.unpack_from(order + "I", header, 4)[0] * 4 if header[0] & 0x7f in (1, 35) else 0
    if length > 16 * 1024 * 1024:
        raise RuntimeError("x11-response-too-large")
    return header + await reader.readexactly(length)


async def read_setup(reader):
    header = await reader.readexactly(12)
    if header[0] not in (ord("l"), ord("B")):
        raise RuntimeError("invalid-x11-byte-order")
    order = "<" if header[0] == ord("l") else ">"
    if struct.unpack_from(order + "H", header, 2)[0] != 11:
        raise RuntimeError("invalid-x11-protocol-version")
    auth, data = struct.unpack_from(order + "HH", header, 6)
    tail = await reader.readexactly(((auth + 3) // 4 + (data + 3) // 4) * 4)
    return header + tail, order


async def read_request(reader, order):
    header = await reader.readexactly(4)
    length = struct.unpack_from(order + "H", header, 2)[0] * 4
    if length == 0:
        header += await reader.readexactly(4)
        length = struct.unpack_from(order + "I", header, 4)[0] * 4
    if not len(header) <= length <= 16 * 1024 * 1024:
        raise RuntimeError("invalid-x11-request-length")
    return header + await reader.readexactly(length - len(header))


def matches_request(packet, order, opcode, mode, keycodes):
    # BIG-REQUESTS 在标准四字节头后插入额外长度字段。
    offset = 4 if packet[2:4] != b"\0\0" else 8
    if mode == "unicode":
        if packet[0] != 100:
            return False
        if len(packet) < offset + 4 or len(packet) != offset + 4 + packet[1] * packet[offset + 1] * 4:
            raise RuntimeError("invalid-x11-keyboard-mapping-request")
        return 0x1004e2d in struct.unpack(order + "I" * ((len(packet) - offset - 4) // 4),
                                         packet[offset + 4:])
    if packet[0] != opcode or packet[1] != 2:
        return False
    if len(packet) != offset + 32:
        raise RuntimeError("invalid-xtest-fake-input-request")
    kind, detail = packet[offset:offset + 2]
    return (kind == 4 and detail == 1) if mode == "button" else (kind == 2 and detail in keycodes)


class InputBarrier:
    def __init__(self, path, target="/tmp/.X11-unix/X99"):
        self.path, self.target = Path(path), target
        self.match = None
        self.hit = asyncio.Event()
        self.lock = asyncio.Lock()
        self.tasks = set()
        self.connections = set()
        self.server = None
        self.accept_task = None
        self.failure = asyncio.get_running_loop().create_future()
        self.forwarded_target = None
        self.identified = asyncio.Event()
        self.check_peer = None

    def authorize(self, check_peer):
        self.check_peer = check_peer
        self.identified.set()

    async def start(self):
        # 拒绝覆盖已有 endpoint；每个 mode 由调用方使用独立 display。
        if self.path.exists():
            raise RuntimeError("fixture-display-already-exists")
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            listener.bind(str(self.path))
            self.server = listener
            os.chmod(self.path, 0o600)
            listener.listen()
            listener.setblocking(False)
            self.accept_task = asyncio.create_task(self.accept())
        except BaseException:
            listener.close()
            raise

    async def accept(self):
        try:
            while True:
                try:
                    connection, _ = self.server.accept()
                except BlockingIOError:
                    await socket_ready(self.server)
                    continue
                # accept 与登记之间没有 await：取消不能遗失已被内核接受但尚未交给任务的 socket。
                connection.setblocking(False)
                self.connections.add(connection)
                self.connected(connection)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            if not self.failure.done():
                self.failure.set_result(error)

    def connected(self, connection):
        task = asyncio.create_task(self.connection(connection))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def connection(self, downstream):
        upstream = None
        client, server = RawReader(downstream), None
        children = []
        try:
            await self.identified.wait()
            self.check_peer(downstream)
            upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            upstream.setblocking(False)
            self.connections.add(upstream)
            server = RawReader(upstream)
            await asyncio.get_running_loop().sock_connect(upstream, self.target)
            setup, order = await read_setup(client)
            if client.fds:
                raise RuntimeError("x11-auth-unexpected-fds")
            await send_packet(upstream, setup, [])

            async def replies():
                initial = True
                while True:
                    packet = await read_reply(server, order, initial=initial)
                    await send_packet(downstream, packet, server.take_fds())
                    if initial and packet[0] != 1:
                        return
                    initial = False

            async def requests():
                while True:
                    packet = await read_request(client, order)
                    async with self.lock:
                        if self.hit.is_set():
                            # 只由 close 取消；不以定时器放行，不发送 release/恢复映射。
                            await asyncio.Future()
                        target = self.match is not None and self.match(packet, order)
                        await send_packet(upstream, packet, client.take_fds())
                        if target:
                            self.forwarded_target = packet
                            self.hit.set()

            children = [asyncio.create_task(requests()), asyncio.create_task(replies())]
            done, _ = await asyncio.wait(children, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        except Exception as error:
            if not self.failure.done():
                self.failure.set_result(error)
        finally:
            for task in children:
                task.cancel()
            await asyncio.gather(*children, return_exceptions=True)
            for reader in (client, server):
                if reader is not None:
                    close_fds(reader.fds)
            for connection in (downstream, upstream):
                if connection is not None:
                    connection.close()
                    self.connections.discard(connection)

    async def close(self):
        if self.accept_task is not None:
            self.accept_task.cancel()
            await asyncio.gather(self.accept_task, return_exceptions=True)
        if self.server is not None:
            self.server.close()
        tasks = list(self.tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        # 极早取消时 connection 协程可能尚未进入 finally，仍回收 accept 已取得的 socket。
        for connection in list(self.connections):
            connection.close()
            self.connections.discard(connection)
        if self.server is not None:
            self.path.unlink(missing_ok=True)
