/**
 * 功能概述：验证真实 supervisor 组合中采集、入站与 action 回执共享一个 socket 的职责边界。
 * 主要职责：FakeSocket 仅代替网络；真实 journal 落盘。分别证明 capture-only 群不进入 ingress、
 * 自身消息不生成入站、发送回执正常解析，以及采集目录故障不会阻断已授权入站。
 * 代码库关系：驱动 createNapCatSupervisor 的生产组合；与 NapCatCapture 文件测试共同验收旁路观察。
 * 输入输出与副作用：随机临时目录与静默 logger；入站使用显式 Promise 信号，停止通过 supervisor.stop
 * 排空文件及 adapter 任务。没有模型、数据库、平台发送网络请求、固定 sleep 或默认短轮询。
 */
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, closeLogger } from "@kaguya/logger";
import type { PlatformInboundMessage } from "@kaguya/platform-adapters";
import { afterEach, expect, it, vi } from "vitest";
import { createNapCatSupervisor } from "./napcat.js";

class FakeSocket {
  static latest: FakeSocket;
  private handlers = new Map<string, Array<(event: unknown) => void>>();
  readonly sent: string[] = [];
  constructor() {
    FakeSocket.latest = this;
  }
  addEventListener(type: string, handler: (event: unknown) => void) {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }
  emit(type: string, data: unknown = {}) {
    for (const callback of this.handlers.get(type) ?? []) callback(data);
  }
  receive(frame: unknown) {
    this.emit("message", { data: JSON.stringify(frame) });
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.emit("close");
  }
}
afterEach(() => vi.unstubAllGlobals());
const event = (group: number, sender: number, messageId: number) => ({
  self_id: 100,
  post_type: "message",
  message_type: "group",
  group_id: group,
  user_id: sender,
  message_id: messageId,
  message: "fictional text",
  time: 1700000000,
});

it("keeps capture-only messages out of ingress while preserving action replies and authorized input", async () => {
  vi.stubGlobal("WebSocket", FakeSocket);
  const root = await mkdtemp(join(tmpdir(), "capture-composition-"));
  const logger = createLogger({ service: "capture-test", level: "silent" });
  const received: PlatformInboundMessage[] = [];
  let submitted!: () => void;
  const ready = new Promise<void>((resolve) => {
    submitted = resolve;
  });
  const supervisor = createNapCatSupervisor({
    config: {
      enabled: true,
      adapterId: "qq",
      wsUrl: "ws://localhost",
      selfId: "100",
      reconnectMs: 100,
      captureEnabled: true,
      captureGroups: ["200"],
    },
    captureRoot: root,
    logger,
    allowsInbound: (message) =>
      message.target.kind === "group" && message.target.groupId === "201",
    ingress: {
      submit: async (message) => {
        received.push(message);
        submitted();
        return { rootInformationId: "fake", deliveries: [] };
      },
    },
  });
  try {
    await supervisor.start();
    const socket = FakeSocket.latest;
    socket.emit("open");
    socket.receive(event(200, 300, 1));
    socket.receive({ ...event(200, 100, 2), post_type: "message_sent" });
    socket.receive(event(201, 300, 3));
    await ready;
    const sending = supervisor.sendMessage(
      { kind: "group", groupId: "201" },
      { kind: "text", text: "test-only" },
    );
    const action = JSON.parse(socket.sent.at(-1)!) as { echo: string };
    socket.receive({
      status: "ok",
      echo: action.echo,
      data: { message_id: 4 },
      token: "DO_NOT_CAPTURE",
    });
    await expect(sending).resolves.toMatchObject({
      ok: true,
      platformMessageId: "4",
    });
    // stop 是 journal fsync 和所有入站任务的完成边界。
    await supervisor.stop();
    expect(received).toHaveLength(1);
    expect(received[0]!.platformMessageId).toBe("3");
    const raw = await readFile(join(root, "qq/100/events.jsonl"), "utf8");
    const records = raw
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as { eventType: string; platformMessageId?: string },
      );
    expect(
      records
        .filter((r) => r.eventType === "message")
        .map((r) => r.platformMessageId),
    ).toEqual(["1", "2"]);
    expect(raw).not.toContain("DO_NOT_CAPTURE");
  } finally {
    await supervisor.stop();
    await closeLogger(logger);
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps authorized ingress running when capture cannot open its private directory", async () => {
  vi.stubGlobal("WebSocket", FakeSocket);
  const root = await mkdtemp(join(tmpdir(), "capture-failure-"));
  const blocked = join(root, "not-a-directory");
  await writeFile(blocked, "fixture");
  const logger = createLogger({ service: "capture-test", level: "silent" });
  let submitted!: () => void;
  const ready = new Promise<void>((resolve) => {
    submitted = resolve;
  });
  const supervisor = createNapCatSupervisor({
    config: {
      enabled: true,
      adapterId: "qq",
      wsUrl: "ws://localhost",
      selfId: "100",
      reconnectMs: 100,
      captureEnabled: true,
      captureGroups: ["200"],
    },
    captureRoot: blocked,
    logger,
    ingress: {
      submit: async () => {
        submitted();
        return { rootInformationId: "fake", deliveries: [] };
      },
    },
  });
  try {
    await supervisor.start();
    FakeSocket.latest.emit("open");
    FakeSocket.latest.receive(event(200, 300, 1));
    await ready;
  } finally {
    await supervisor.stop();
    await closeLogger(logger);
    await rm(root, { recursive: true, force: true });
  }
});
