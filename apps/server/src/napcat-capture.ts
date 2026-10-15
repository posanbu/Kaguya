/**
 * 功能概述：在现有 NapCat socket 上旁路采集完整群事件，写入私有追加 journal 和一致性检查点。
 * 主要职责：CaptureJournal.open 恢复完整行、接收序号及去重集合，独占锁防止双写；append 串行 fsync
 * 后原子替换字节水位/哈希检查点，settle/close 给出可观察的收尾边界。NapCatCapture 验证连接代次、
 * 登录身份与群范围，恢复自身发言/撤回/媒体类型；checkpoint 只为已验证且健康的连接声明完整覆盖。
 * fault/overflow/断线/重启/时钟回退/心跳过期形成 gap，I/O 失败后停止写入并报告固定错误类型。
 * 代码库关系：napcat.ts 复用其现有 JSON transport 订阅；不引用 ingress、Runtime、Memory 或模型。
 * journal 的 message/recall/coverage 行直接对接 benchmarks/participation/core.py；导出器只读取提交字节前缀。
 * 输入输出与副作用：创建 0700 目录、0600 文件和可恢复进程锁；私有记录含稳定平台身份及消息正文。
 * Windows 的追加权限不提供尾部截断所需的普通写权限；恢复用 r+/wx+ 打开，并按已提交字节偏移写满。
 * 未知 frame、凭据和 action 回执不写入 journal。所有异步写入可通过 settle 等待，不阻塞平台事件回调。
 */
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { readSensitiveJson, writeSensitiveJson } from "@kaguya/config";
import { normalizeOneBotCaptureContent } from "@kaguya/platform-adapters";
import type { NapCatCaptureSettings } from "./napcat-capture-config.js";

export type CaptureScope = {
  platform: "qq";
  adapterId: string;
  accountId: string;
  groupId: string;
};
export type CaptureRecord = {
  schemaVersion: 1;
  recordId: string;
  captureSeq: number;
  receivedAt: string;
  occurredAt: string;
  eventType: "message" | "recall" | "coverage";
  scope: CaptureScope;
  [key: string]: unknown;
};
type Draft = {
  occurredAt: string;
  eventType: "message" | "recall" | "coverage";
  scope: CaptureScope;
  [key: string]: unknown;
};
export type CaptureCheckpoint = {
  schemaVersion: 1;
  bytes: number;
  captureSeq: number;
  receivedAt: string;
  sha256: string;
  counters: Record<string, number>;
};

/** 单机锁文件带唯一 nonce；只回收同机已死亡的 owner，不删除其他实例新建的锁。 */
async function acquireLock(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink())
    throw new Error("unsafe capture directory");
  await chmod(directory, 0o700);
  const locks = join(directory, "locks");
  await mkdir(locks, { mode: 0o700, recursive: true });
  if ((await lstat(locks)).isSymbolicLink())
    throw new Error("unsafe capture locks");
  const own = join(locks, `${randomUUID()}.json`);
  const file = await open(own, "wx", 0o600);
  try {
    await file.writeFile(
      JSON.stringify({ host: hostname(), pid: process.pid }),
    );
  } catch (error) {
    await unlink(own).catch(() => undefined);
    throw error;
  } finally {
    await file.close();
  }
  try {
    for (const name of await readdir(locks)) {
      const other = join(locks, name);
      if (other === own) continue;
      let owner: { host: string; pid: number };
      try {
        owner = JSON.parse(await readFile(other, "utf8")) as typeof owner;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (
        owner.host !== hostname() ||
        !Number.isSafeInteger(owner.pid) ||
        owner.pid < 1
      )
        throw new Error("capture already locked");
      let alive = true;
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      }
      if (alive) throw new Error("capture already locked");
      await unlink(other).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    return own;
  } catch (error) {
    await unlink(own);
    throw error;
  }
}

export async function writeCaptureBytes(
  file: FileHandle,
  data: Buffer,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await file.write(
      data,
      offset,
      data.length - offset,
      position + offset,
    );
    if (bytesWritten <= 0) throw new Error("capture write made no progress");
    offset += bytesWritten;
  }
}

export class CaptureJournal {
  private handle: FileHandle | undefined;
  private lock: string | undefined;
  private tail: Promise<void> = Promise.resolve();
  private hash = createHash("sha256");
  private bytes = 0;
  private committed: CaptureCheckpoint | undefined;
  readonly records: CaptureRecord[] = [];
  failed = false;

  constructor(
    readonly directory: string,
    private readonly onError: () => void,
    private readonly write: (
      handle: FileHandle,
      data: Buffer,
      position: number,
    ) => Promise<void> = writeCaptureBytes,
  ) {}

  async open(): Promise<void> {
    this.lock = await acquireLock(this.directory);
    try {
      const path = join(this.directory, "events.jsonl");
      try {
        if ((await lstat(path)).isSymbolicLink())
          throw new Error("unsafe journal");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      try {
        this.handle = await open(path, "r+", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        this.handle = await open(path, "wx+", 0o600);
      }
      await this.handle.chmod(0o600);
      const raw = await readFile(path);
      const complete = raw.subarray(0, raw.lastIndexOf(10) + 1);
      let previous = 0;
      let previousTime = "";
      for (const line of complete
        .toString("utf8")
        .split("\n")
        .filter(Boolean)) {
        const record = JSON.parse(line) as CaptureRecord;
        if (
          record.schemaVersion !== 1 ||
          !Number.isSafeInteger(record.captureSeq) ||
          record.captureSeq <= previous ||
          !["message", "recall", "coverage"].includes(record.eventType) ||
          !Number.isFinite(Date.parse(record.receivedAt)) ||
          (previousTime &&
            Date.parse(record.receivedAt) < Date.parse(previousTime))
        )
          throw new Error("corrupt capture journal");
        previous = record.captureSeq;
        previousTime = record.receivedAt;
        this.records.push(record);
      }
      if (complete.length !== raw.length)
        await this.handle.truncate(complete.length);
      await this.handle.sync();
      this.hash.update(complete);
      this.bytes = complete.length;
      // 已有检查点必须对应实际持久化前缀；旧检查点可在完整行恢复后前移。
      try {
        const checkpoint = (await readSensitiveJson(
          join(this.directory, "checkpoint.json"),
        )) as CaptureCheckpoint;
        if (
          !Number.isSafeInteger(checkpoint.bytes) ||
          checkpoint.bytes < 0 ||
          checkpoint.bytes > complete.length ||
          createHash("sha256")
            .update(complete.subarray(0, checkpoint.bytes))
            .digest("hex") !== checkpoint.sha256
        )
          throw new Error("checkpoint mismatch");
        this.committed = checkpoint;
      } catch (error) {
        const code = error as { cause?: NodeJS.ErrnoException; code?: string };
        if (code.code !== "ENOENT" && code.cause?.code !== "ENOENT")
          throw error;
      }
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  append(
    records: CaptureRecord[],
    counters: Record<string, number>,
  ): Promise<void> {
    const payload = Buffer.from(
      records.map((r) => `${JSON.stringify(r)}\n`).join(""),
    );
    this.tail = this.tail
      .then(async () => {
        if (this.failed || !this.handle || !records.length) return;
        await this.write(this.handle, payload, this.bytes);
        await this.handle.sync();
        this.hash.update(payload);
        this.bytes += payload.length;
        const last = records.at(-1)!;
        const checkpoint: CaptureCheckpoint = {
          schemaVersion: 1,
          bytes: this.bytes,
          captureSeq: last.captureSeq,
          receivedAt: last.receivedAt,
          sha256: this.hash.copy().digest("hex"),
          counters,
        };
        await writeSensitiveJson(
          join(this.directory, "checkpoint.json"),
          checkpoint,
        );
        this.committed = checkpoint;
      })
      .catch(() => {
        this.failed = true;
        try {
          this.onError();
        } catch {
          /* Diagnostics only. */
        }
      });
    return this.tail;
  }

  snapshot(): CaptureCheckpoint | undefined {
    return this.committed;
  }
  settle(): Promise<void> {
    return this.tail;
  }

  async close(): Promise<void> {
    await this.tail;
    await this.handle?.close();
    this.handle = undefined;
    if (this.lock) await unlink(this.lock);
    this.lock = undefined;
  }
}

type Segment = { start: number; gap: boolean; reason: string };
const CHECKPOINT_MS = 30_000;
const HEARTBEAT_LIMIT_MS = 60_000;

export class NapCatCapture {
  private journal: CaptureJournal | undefined;
  private sequence = 0;
  private lastReceived = 0;
  private generation: string | undefined;
  private verified = false;
  private lastVerified = 0;
  private timer: NodeJS.Timeout | undefined;
  private pending = 0;
  private seen = new Map<string, string>();
  private segments = new Map<string, Segment>();
  private failed = false;
  readonly counters: Record<string, number> = {
    messages: 0,
    recalls: 0,
    duplicates: 0,
    unknown: 0,
    identityMismatch: 0,
    queueOverflow: 0,
    clockRollback: 0,
  };

  constructor(
    private readonly options: NapCatCaptureSettings & {
      directory: string;
      adapterId: string;
      selfId: string;
      now?: () => Date;
      onError?: () => void;
      journalFactory?: (
        directory: string,
        onError: () => void,
      ) => CaptureJournal;
    },
  ) {}

  private now(): number {
    const time = (this.options.now?.() ?? new Date()).getTime();
    const watermark = Math.max(this.lastReceived, this.lastVerified);
    if (time < watermark) {
      this.counters.clockRollback!++;
      this.fault("clock_rollback");
    }
    return Math.max(time, watermark);
  }
  private scope(groupId: string): CaptureScope {
    return {
      platform: "qq",
      adapterId: this.options.adapterId,
      accountId: this.options.selfId,
      groupId,
    };
  }
  async start(): Promise<void> {
    if (!this.options.captureEnabled || this.journal) return;
    this.failed = false;
    try {
      const onError = () => {
        this.failed = true;
        try {
          this.options.onError?.();
        } catch {
          /* Diagnostics cannot stop ingress. */
        }
      };
      this.journal =
        this.options.journalFactory?.(this.options.directory, onError) ??
        new CaptureJournal(this.options.directory, onError);
      await this.journal.open();
      this.sequence = 0;
      this.lastReceived = 0;
      this.seen.clear();
      this.segments.clear();
      const endpoints = new Map<string, number>();
      for (const record of this.journal.records) {
        if (
          record.scope.accountId !== this.options.selfId ||
          record.scope.adapterId !== this.options.adapterId ||
          record.scope.platform !== "qq"
        )
          throw new Error("capture account mismatch");
        this.sequence = record.captureSeq;
        this.lastReceived = Date.parse(record.receivedAt);
        endpoints.set(record.scope.groupId, this.lastReceived);
        if (record.eventType === "message")
          this.seen.set(
            this.key(record.scope.groupId, String(record.platformMessageId)),
            this.fingerprint(record),
          );
      }
      for (const group of this.options.captureGroups ?? []) {
        const end = endpoints.get(group);
        if (end !== undefined)
          this.segments.set(group, {
            start: end - 1,
            gap: true,
            reason: "process_restart",
          });
      }
      // 重启导出保留累计覆盖计数；新连接代次仍从未验证状态开始。
      const recovered = this.journal.snapshot()?.counters;
      for (const key of Object.keys(this.counters)) this.counters[key] = 0;
      if (recovered)
        for (const key of Object.keys(this.counters)) {
          if (Number.isSafeInteger(recovered[key]) && recovered[key]! >= 0)
            this.counters[key] = recovered[key]!;
        }
      this.counters.messages = this.journal.records.filter(
        (r) => r.eventType === "message",
      ).length;
      this.counters.recalls = this.journal.records.filter(
        (r) => r.eventType === "recall",
      ).length;
      this.journal.records.length = 0;
      this.timer = setInterval(() => this.checkpoint(), CHECKPOINT_MS);
      this.timer.unref();
    } catch {
      this.failed = true;
      await this.journal?.close().catch(() => undefined);
      this.journal = undefined;
      try {
        this.options.onError?.();
      } catch {
        /* Diagnostics only. */
      }
    }
  }

  connected(generation: string): void {
    this.generation = generation;
    this.verified = false;
  }
  disconnected(generation: string): void {
    if (this.generation !== generation) return;
    this.checkpoint();
    this.fault("disconnect");
    this.generation = undefined;
  }
  fault(reason: string): void {
    this.verified = false;
    for (const segment of this.segments.values()) {
      segment.start -= segment.gap ? 0 : 1;
      segment.gap = true;
      segment.reason = reason;
    }
  }
  malformed(generation: string): void {
    if (this.generation !== generation) return;
    this.counters.unknown!++;
    this.fault("malformed_frame");
  }
  private key(group: string, id: string): string {
    return `${group}:${id}`;
  }
  private fingerprint(record: Record<string, unknown>): string {
    return createHash("sha256")
      .update(
        JSON.stringify([
          record.senderId,
          record.text,
          record.mentions,
          record.replyTo,
          record.mediaTypes,
        ]),
      )
      .digest("hex");
  }
  receive(frame: unknown, generation: string): void {
    if (!this.journal || this.failed || this.generation !== generation) return;
    try {
      this.observe(frame);
    } catch {
      this.counters.unknown!++;
      this.fault("invalid_event");
    }
  }
  private observe(frame: unknown): void {
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
      this.counters.unknown!++;
      this.fault("invalid_event");
      return;
    }
    const event = frame as Record<string, unknown>;
    if (Object.hasOwn(event, "echo")) return;
    // 私聊、未配置群不进入采集或身份状态；不从 action 回执合成已投递消息。
    const group = id(event.group_id);
    if (
      event.message_type === "private" ||
      (group && !this.options.captureGroups?.includes(group))
    )
      return;
    if (id(event.self_id) !== this.options.selfId) {
      this.counters.identityMismatch!++;
      this.fault("identity_mismatch");
      return;
    }
    const time = this.now();
    if (this.verified && time - this.lastVerified > HEARTBEAT_LIMIT_MS)
      this.fault("heartbeat_timeout");
    if (
      event.post_type === "meta_event" &&
      ["heartbeat", "lifecycle"].includes(String(event.meta_event_type))
    ) {
      const status =
        typeof event.status === "object" && event.status !== null
          ? (event.status as Record<string, unknown>)
          : undefined;
      if (
        (event.meta_event_type === "heartbeat" &&
          (status?.good !== true || status.online === false)) ||
        (event.meta_event_type === "lifecycle" &&
          !["connect", "enable"].includes(String(event.sub_type)))
      ) {
        this.fault("napcat_unhealthy");
        return;
      }
      if (this.pending >= (this.options.captureQueueLimit ?? 1000)) {
        this.counters.queueOverflow!++;
        this.fault("queue_overflow");
        return;
      }
      this.enqueue(this.verify(time), time);
      return;
    }
    if (!group) {
      this.counters.unknown!++;
      this.fault("unknown_event");
      return;
    }
    const messageId = id(event.message_id, true);
    const occurred =
      typeof event.time === "number" && Number.isFinite(event.time)
        ? new Date(event.time * 1000).toISOString()
        : new Date(time).toISOString();
    let draft: Draft;
    if (
      (event.post_type === "message" || event.post_type === "message_sent") &&
      event.message_type === "group" &&
      messageId &&
      id(event.user_id)
    ) {
      const content = normalizeOneBotCaptureContent(event.message);
      if (!content) throw new Error("invalid message segments");
      if (
        content.mentions.some(
          (mention) => mention.kind !== "all" && !id(mention.id),
        ) ||
        (content.replyTo && !id(content.replyTo.platformMessageId, true))
      )
        throw new Error("invalid message addressing");
      const sender =
        typeof event.sender === "object" && event.sender !== null
          ? (event.sender as Record<string, unknown>)
          : {};
      const name =
        typeof sender.card === "string" && sender.card.trim()
          ? sender.card
          : sender.nickname;
      draft = {
        eventType: "message",
        scope: this.scope(group),
        occurredAt: occurred,
        platformMessageId: messageId,
        senderId: id(event.user_id),
        text: content.text,
        senderName:
          typeof name === "string" && name.trim() ? name.slice(0, 1000) : null,
        mentions: content.mentions.map((mention) =>
          mention.kind === "all" ? "all" : mention.id,
        ),
        replyTo: content.replyTo
          ? {
              scope: this.scope(group),
              platformMessageId: content.replyTo.platformMessageId,
            }
          : null,
        mediaTypes: content.mediaTypes,
      };
      const key = this.key(group, messageId);
      const previous = this.seen.get(key);
      if (previous !== undefined) {
        this.counters.duplicates!++;
        if (previous !== this.fingerprint(draft))
          this.fault("duplicate_conflict");
        return;
      }
    } else if (
      event.post_type === "notice" &&
      event.notice_type === "group_recall" &&
      messageId
    ) {
      draft = {
        eventType: "recall",
        scope: this.scope(group),
        occurredAt: occurred,
        platformMessageId: messageId,
      };
    } else {
      this.counters.unknown!++;
      this.fault("unsupported_group_event");
      return;
    }
    if (this.pending >= (this.options.captureQueueLimit ?? 1000)) {
      this.counters.queueOverflow!++;
      this.fault("queue_overflow");
      return;
    }
    const recovery = this.verify(time);
    draft.occurredAtSource =
      typeof event.time === "number" && Number.isFinite(event.time)
        ? "platform_seconds"
        : "received_fallback";
    if (draft.eventType === "message") {
      this.seen.set(this.key(group, messageId!), this.fingerprint(draft));
      this.counters.messages!++;
    } else this.counters.recalls!++;
    this.enqueue([...recovery, draft], time);
  }

  private verify(time: number): Draft[] {
    const recovery: Draft[] = [];
    for (const group of this.options.captureGroups ?? []) {
      const segment = this.segments.get(group);
      if (segment?.gap && time > segment.start)
        recovery.push(
          this.coverage(group, segment.start, time, "gap", segment.reason),
        );
      if (!segment || segment.gap)
        this.segments.set(group, {
          start: time,
          gap: false,
          reason: "connected",
        });
    }
    this.verified = true;
    this.lastVerified = time;
    return recovery;
  }
  private coverage(
    group: string,
    start: number,
    end: number,
    status: string,
    reason: string,
  ): Draft {
    return {
      eventType: "coverage",
      scope: this.scope(group),
      occurredAt: new Date(end).toISOString(),
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      status,
      reason,
      counters: { ...this.counters },
    };
  }
  checkpoint(): void {
    if (!this.journal || this.failed || !this.generation) return;
    const time = this.now();
    if (time - this.lastVerified > HEARTBEAT_LIMIT_MS)
      this.fault("heartbeat_timeout");
    if (this.pending >= (this.options.captureQueueLimit ?? 1000)) {
      this.fault("checkpoint_backpressure");
      return;
    }
    const records: Draft[] = [];
    for (const [group, segment] of this.segments) {
      if (time <= segment.start) continue;
      records.push(
        this.coverage(
          group,
          segment.start,
          time,
          this.verified && !segment.gap ? "complete" : "gap",
          segment.reason,
        ),
      );
      segment.start = time;
    }
    this.enqueue(records, time);
  }
  private enqueue(drafts: Draft[], time: number): void {
    if (!drafts.length || !this.journal || this.failed) return;
    const receivedAt = new Date(
      Math.max(time, this.lastReceived),
    ).toISOString();
    this.lastReceived = Date.parse(receivedAt);
    const records = drafts.map((draft) => ({
      ...draft,
      schemaVersion: 1 as const,
      captureSeq: ++this.sequence,
      recordId: `${this.options.adapterId}:${this.sequence}`,
      receivedAt,
      connectionGeneration: this.generation,
      receivedAtSource: "wall_clock_ms_monotonic",
    })) as CaptureRecord[];
    this.pending++;
    void this.journal.append(records, { ...this.counters }).finally(() => {
      this.pending--;
    });
  }
  async settle(): Promise<void> {
    await this.journal?.settle();
  }
  status(): {
    state: string;
    counters: Record<string, number>;
    checkpoint?: CaptureCheckpoint;
  } {
    const checkpoint = this.journal?.snapshot();
    return {
      state: !this.options.captureEnabled
        ? "disabled"
        : this.failed
          ? "failed"
          : !this.journal
            ? "stopped"
            : this.verified
              ? "capturing"
              : "waiting_for_identity",
      counters: { ...this.counters },
      ...(checkpoint ? { checkpoint } : {}),
    };
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.checkpoint();
    this.generation = undefined;
    this.verified = false;
    await this.journal?.close();
    this.journal = undefined;
  }
}

function id(value: unknown, allowNegative = false): string | undefined {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && (allowNegative || value > 0)
      ? String(value)
      : undefined;
  if (
    typeof value === "string" &&
    (allowNegative ? /^-?[0-9]+$/u : /^[1-9][0-9]*$/u).test(value)
  )
    return value;
  return undefined;
}
