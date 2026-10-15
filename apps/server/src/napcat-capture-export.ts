/**
 * 功能概述：从已提交字节水位导出 NapCat journal 的一致性私有快照，支持采集同时运行。
 * 主要职责：freezeCapture 读取一次原子检查点，只复制其哈希对应的完整行前缀；HMAC 转换
 * 账号、群、成员、消息和引用身份，保留跨群同人的连续性，单独保存私有身份映射。
 * main 解析显式目录/密钥文件/输出参数；输出目录独占，半成品带 incomplete 标记。
 * 代码库关系：读取 napcat-capture.ts 的 checkpoint/events，生成 participation/core.py 的 v1 JSONL；
 * 不连接 NapCat、数据库或模型，不启动采集，不补查当前昵称和未来引用。
 * 输入输出与副作用：只读来源；输出 0700/0600 私有文件，密钥至少 32 字节，不复制密钥。
 * 文本中结构化 @/reply 标识随身份转换，原始正文仍需人工隐私审核；此命令不授权公开语料。
 */
import { createHash, createHmac } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readSensitiveJson } from "@kaguya/config";
import type {
  CaptureCheckpoint,
  CaptureRecord,
  CaptureScope,
} from "./napcat-capture.js";

async function privateFile(path: string, content: string): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function freezeCapture(options: {
  journalDirectory: string;
  identityKeyFile: string;
  output: string;
}): Promise<{ records: number; source_sha256: string }> {
  const key = await readFile(options.identityKeyFile);
  if (key.length < 32)
    throw new Error("Identity key requires at least 32 bytes");
  const checkpoint = (await readSensitiveJson(
    join(options.journalDirectory, "checkpoint.json"),
  )) as CaptureCheckpoint;
  if (
    checkpoint.schemaVersion !== 1 ||
    !Number.isSafeInteger(checkpoint.bytes) ||
    checkpoint.bytes <= 0
  )
    throw new Error("Invalid capture checkpoint");
  const file = await open(join(options.journalDirectory, "events.jsonl"), "r");
  let prefix: Buffer;
  try {
    if ((await file.stat()).size < checkpoint.bytes)
      throw new Error("Capture checkpoint exceeds journal");
    prefix = Buffer.alloc(checkpoint.bytes);
    let offset = 0;
    while (offset < prefix.length) {
      const { bytesRead } = await file.read(
        prefix,
        offset,
        prefix.length - offset,
        offset,
      );
      if (!bytesRead) throw new Error("Capture prefix shortened during export");
      offset += bytesRead;
    }
  } finally {
    await file.close();
  }
  if (
    prefix.at(-1) !== 10 ||
    createHash("sha256").update(prefix).digest("hex") !== checkpoint.sha256
  )
    throw new Error("Capture prefix hash mismatch");
  const mapping = new Map<
    string,
    { kind: string; original: string; pseudonym: string }
  >();
  const pseudonym = (
    kind: string,
    value: string,
    namespace: string,
  ): string => {
    const identity = JSON.stringify([kind, namespace, value]);
    const result = `${kind}-${createHmac("sha256", key).update(identity).digest("hex").slice(0, 32)}`;
    mapping.set(identity, { kind, original: value, pseudonym: result });
    return result;
  };
  const rawRecords = prefix
    .toString("utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as CaptureRecord);
  const records = rawRecords.map((record) => {
    const scope = record.scope;
    const namespace = JSON.stringify([
      scope.platform,
      scope.adapterId,
      scope.accountId,
    ]);
    const person = (value: string) => pseudonym("person", value, namespace);
    const message = (value: string) =>
      pseudonym("message", value, `${namespace}:${scope.groupId}`);
    const mappedScope: CaptureScope = {
      ...scope,
      accountId: person(scope.accountId),
      groupId: pseudonym("group", scope.groupId, namespace),
    };
    const result: CaptureRecord = {
      ...record,
      recordId: pseudonym("record", record.recordId, namespace),
      scope: mappedScope,
    };
    if (record.eventType === "message") {
      result.senderId = person(String(record.senderId));
      result.senderName = null;
      const mentions = record.mentions as string[];
      result.mentions = mentions.map((id) => (id === "all" ? id : person(id)));
      let text = String(record.text);
      for (const id of mentions)
        if (id !== "all")
          text = text.replace(
            new RegExp(`@${id}(?![0-9])`, "gu"),
            `@${person(id)}`,
          );
      const reply = record.replyTo as {
        scope: CaptureScope;
        platformMessageId: string;
      } | null;
      if (reply) {
        if (JSON.stringify(reply.scope) !== JSON.stringify(scope))
          throw new Error("Unexpected cross-scope capture reference");
        result.replyTo = {
          scope: mappedScope,
          platformMessageId: message(reply.platformMessageId),
        };
        text = text.replaceAll(
          `[reply:${reply.platformMessageId}]`,
          `[reply:${message(reply.platformMessageId)}]`,
        );
      }
      result.text = text;
    }
    if (record.platformMessageId !== undefined)
      result.platformMessageId = message(String(record.platformMessageId));
    return result;
  });
  if (records.at(-1)?.captureSeq !== checkpoint.captureSeq)
    throw new Error("Capture sequence checkpoint mismatch");
  const source = records
    .map((record) => `${JSON.stringify(record)}\n`)
    .join("");
  const sourceHash = createHash("sha256").update(source).digest("hex");
  await mkdir(dirname(options.output), { recursive: true, mode: 0o700 });
  await mkdir(options.output, { mode: 0o700 });
  await privateFile(join(options.output, "incomplete.json"), "{}\n");
  await privateFile(join(options.output, "events.jsonl"), source);
  await privateFile(
    join(options.output, "identity-map.private.json"),
    `${JSON.stringify([...mapping.values()], null, 2)}\n`,
  );
  await privateFile(
    join(options.output, "manifest.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        protocol: "kaguya-participation/v1",
        data_kind: "private",
        records: records.length,
        source_sha256: sourceHash,
        capture_prefix_sha256: checkpoint.sha256,
        capture_bytes: checkpoint.bytes,
        capture_seq: checkpoint.captureSeq,
        identity_transform: "hmac-sha256/v1",
      },
      null,
      2,
    )}\n`,
  );
  await unlink(join(options.output, "incomplete.json"));
  return { records: records.length, source_sha256: sourceHash };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "journal-dir": { type: "string" },
      "identity-key-file": { type: "string" },
      output: { type: "string" },
    },
  });
  if (!values["journal-dir"] || !values["identity-key-file"] || !values.output)
    throw new Error("Require --journal-dir, --identity-key-file and --output");
  console.log(
    JSON.stringify(
      await freezeCapture({
        journalDirectory: resolve(values["journal-dir"]),
        identityKeyFile: resolve(values["identity-key-file"]),
        output: resolve(values.output),
      }),
    ),
  );
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  void main().catch(() => {
    console.error(
      "Capture export failed: check arguments, private key and committed journal prefix.",
    );
    process.exitCode = 1;
  });
}
