#!/usr/bin/env python3
"""功能概述：专用 UID 下的 Unix broker 服务入口，仅允许内核 SO_PEERCRED 确认的宿主 UID。
主要职责：serve 固定 RPC 白名单、请求大小/时限/并发；Handler 不记录原始请求或异常；
shutdown 隔离全部受管容器并保留 journal；expiry worker 撤销过期人工输入且不恢复自动化。
health 不会创建环境或拉取镜像；expiry 异常停止服务，清理必须等待 worker 退出。
代码库关系：bootstrap.py 安装 root 拥有的此文件和 broker.py；runtime/environment.ts 调用协议 1。
输入输出与副作用：一连接一个 JSON 行；凭证只在内存经过，不传入 helper/回执；不开放 TCP。
"""
import json
import os
from pathlib import Path
import signal
import socket
import socketserver
import stat
import struct
import subprocess
import sys
import threading

# -I 禁用环境注入；仅恢复本文件所在的受信安装目录。
sys.path.insert(0, str(Path(__file__).resolve().parent))
from broker import Broker, BrokerError, PodmanBackend, verify_storage_mount  # noqa: E402

MAX_REQUEST = 262144
METHODS = {"environment.create": "create", "environment.recover": "takeover",
           "environment.inspect": "inspect",
           "environment.handoff": "handoff", "environment.resume": "resume",
           "human.renew": "human_renew", "human.close": "human_close", "human.execute": "human_execute", "human.query": "human_query",
           "lease.acquire": "acquire", "lease.renew": "renew", "lease.release": "release",
           "lease.validate": "validate", "operation.execute": "execute", "operation.cancel": "cancel",
           "operation.reconcile": "reconcile", "artifact.read": "read_artifact"}


def parse_json(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise BrokerError("duplicate-json-key")
            result[key] = value
        return result
    def invalid(_):
        raise BrokerError("nonfinite-json-number")
    return json.loads(data, object_pairs_hook=unique, parse_constant=invalid)


def peer_uid(connection):
    if not hasattr(socket, "SO_PEERCRED"):
        raise BrokerError("linux-peercred-required")
    _, uid, _ = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))
    return uid


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    block_on_close = False
    allow_reuse_address = False

    def __init__(self, path, broker, trusted_uid):
        self.broker, self.trusted_uid = broker, trusted_uid
        self.capacity = threading.BoundedSemaphore(16)
        self.handlers = threading.Condition()
        self.connections = set()
        self.stopping = False
        super().__init__(str(path), Handler)

    def verify_request(self, request, client_address):
        return not self.stopping and peer_uid(request) == self.trusted_uid

    def process_request(self, request, client_address):
        if not self.capacity.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            with self.handlers:
                self.connections.add(request)
            super().process_request(request, client_address)
        except BaseException:
            with self.handlers:
                self.connections.discard(request)
                self.handlers.notify_all()
            self.capacity.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            with self.handlers:
                self.connections.discard(request)
                self.handlers.notify_all()
            self.capacity.release()

    def stop_reads(self):
        with self.handlers:
            for connection in self.connections:
                try:
                    connection.shutdown(socket.SHUT_RD)
                except OSError:
                    pass

    def wait_handlers(self, timeout=15):
        with self.handlers:
            return self.handlers.wait_for(lambda: not self.connections, timeout)

    def handle_error(self, request, client_address):
        # 不输出 Python traceback，其中可能含请求或 provider 内容。
        pass


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(10)
        try:
            line = self.rfile.readline(MAX_REQUEST + 1)
            if len(line) > MAX_REQUEST or not line.endswith(b"\n"):
                raise BrokerError("invalid-request-size")
            request = parse_json(line)
            if not isinstance(request, dict) or set(request) != {"protocol", "method", "params"} or type(request["protocol"]) is not int or request["protocol"] != 1:
                raise BrokerError("invalid-protocol")
            if not isinstance(request["params"], dict):
                raise BrokerError("invalid-params")
            method = request["method"]
            if method == "health":
                result = {"protocol": 1, "ready": not self.server.stopping and not self.server.broker.faulted,
                          "serviceUid": os.getuid(), "environments": len(self.server.broker.environments)}
            elif method == "image.import":
                result = self.server.broker.backend.import_image(request["params"]["sha256"])
            elif method in METHODS:
                result = getattr(self.server.broker, METHODS[method])(request["params"])
            else:
                raise BrokerError("method-not-allowed")
            response = {"ok": True, "result": result}
        except BrokerError as error:
            response = {"ok": False, "error": str(error)}
        except Exception:
            response = {"ok": False, "error": "request-unconfirmed"}
        self.wfile.write(json.dumps(response, separators=(",", ":"), allow_nan=False).encode() + b"\n")


def serve(config_path):
    path = Path(config_path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise BrokerError("untrusted-config")
    config = parse_json(path.read_text())
    if os.getuid() == 0 or config["serviceUid"] != os.getuid() or config["trustedUid"] == os.getuid():
        raise BrokerError("incorrect-service-identity")
    for mount in config["mounts"]:
        verify_storage_mount(Path(mount), Path(mount).with_suffix(".img"))
    backend = PodmanBackend()
    broker = Broker(Path(config["state"]), backend, max_environments=config["maxEnvironments"],
                    max_artifact_bytes=config["maxArtifactBytes"], max_stored_bytes=config["maxStoredBytes"])
    socket_path = Path(config["socket"])
    if socket_path.exists() or socket_path.is_symlink():
        info = socket_path.lstat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
            raise BrokerError("unsafe-socket-path")
        # journal flock 已确认没有另一个 broker；只移除自己留下的 socket。
        socket_path.unlink()
    server = Server(socket_path, broker, config["trustedUid"])
    os.chmod(socket_path, 0o600)
    subprocess.run(["/usr/bin/setfacl", "-m", f"u:{config['trustedUid']}:rw", str(socket_path)],
                   check=True, timeout=10, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def stop(_signum, _frame):
        server.stopping = True
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    expiry_stop = threading.Event()
    def expire():
        try:
            while not expiry_stop.wait(0.2):
                broker.expire_humans()
        except Exception:
            broker.faulted = True
            server.stopping = True
            server.shutdown()
    expiry_worker = threading.Thread(target=expire, name="human-session-expiry", daemon=True)
    expiry_worker.start()
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.stopping = True
        expiry_stop.set()
        server.server_close()
        server.stop_reads()
        expiry_worker.join(35)
        if expiry_worker.is_alive():
            # 不在 worker 可能持有环境锁并写 journal 时关闭 journal；进程退出释放资源。
            raise BrokerError("human-expiry-worker-did-not-stop")
        try:
            broker.close()
        finally:
            settled = server.wait_handlers()
            socket_path.unlink(missing_ok=True)
        if not settled:
            raise BrokerError("handlers-did-not-stop")


if __name__ == "__main__":
    try:
        serve(sys.argv[1])
    except Exception:
        print("kaguya-tools: startup-or-isolation-failed", file=sys.stderr)
        sys.exit(1)
