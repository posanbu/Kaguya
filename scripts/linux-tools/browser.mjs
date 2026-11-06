/**
 * 功能概述：持久 Chromium 的可信 DOM 组件，提供 observe/act/verify 和下载归档。
 * 主要职责：私有 pipe 承载所有 CDP；观察记录绑定 scope/lease/generation 与实际 DOM；
 * handoff 先封闭输入并清空观察，再等待真实 CDP 回执，保留 PID、页面、profile 与未保存状态。
 * 代码库关系：ToolService 注入权威 mode/generation；broker 固定许可并保存最终回执/附件。
 * 输入输出与副作用：只用 /private 保存 profile/下载；页面核对包含控件选中状态，只证明当前状态，不推断原输入因果。
 */
import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  open,
  readdir,
} from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { ChromiumConnection } from "./chromium-connection.mjs";
import { BrowserInputGate } from "./browser-input.mjs";
import { activateDomFunction, readDomExpression } from "./browser-dom.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const identity = (state) => ({
  url: state.url,
  viewport: state.viewport,
  html: state.html,
  inputs: state.inputs,
});
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const output = (
  result,
  artifacts = [],
  status = "succeeded",
  evidence = "returned",
) => ({ status, evidence, result, artifacts, truncated: false });

export class BrowserComponent {
  constructor({
    root = "/private/browser",
    executable,
    connectionFactory = (path, profile) =>
      new ChromiumConnection(path, profile),
  } = {}) {
    this.root = root;
    this.executable = executable;
    this.connectionFactory = connectionFactory;
    this.capabilities = ["browser.observe", "browser.act", "browser.verify"];
    this.observations = new Map();
    this.downloads = new Map();
    this.responses = new Map();
    this.sessions = new Map();
    this.downloadTasks = new Set();
    this.gate = new BrowserInputGate({
      allowed: () =>
        this.service?.mode === "automation" && !this.service.closed,
    });
  }

  async ready(service) {
    this.service = service;
    await mkdir(join(this.root, "downloads"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.root, "profile"), { recursive: true, mode: 0o700 });
    if (!this.executable) {
      const { chromium } =
        await import("/opt/kaguya-browser/node_modules/playwright/index.mjs");
      this.executable = chromium.executablePath();
    }
    for (const name of await readdir(join(this.root, "downloads"))) {
      if (!name.endsWith(".json") || !uuid.test(name.slice(0, -5))) continue;
      const metadata = JSON.parse(
        await readFile(join(this.root, "downloads", name), "utf8"),
      );
      if (metadata.id !== name.slice(0, -5))
        throw new Error("invalid-download-metadata");
      this.downloads.set(metadata.id, metadata);
    }
    this.connection = this.connectionFactory(
      this.executable,
      join(this.root, "profile"),
    );
    this.connection.on("event", (event) => this.event(event));
    this.version = await this.connection.send("Browser.getVersion");
    await this.connection.send("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      downloadPath: join(this.root, "downloads"),
      eventsEnabled: true,
    });
    let page;
    const readyDeadline = Date.now() + 10000;
    while (!page) {
      try {
        page = await this.page();
      } catch (error) {
        if (
          error.message !== "browser-page-unavailable" ||
          Date.now() >= readyDeadline
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    this.initialTargetId = page.targetId;
    await this.bootstrapNavigate(page, "chrome://sandbox");
    const sandboxDeadline = Date.now() + 5000;
    while (true) {
      const current = await this.page();
      const state = await this.state(current);
      this.sandbox = state.text;
      if (/You are adequately sandboxed\./.test(this.sandbox)) break;
      if (Date.now() >= sandboxDeadline)
        throw new Error("chromium-sandbox-unconfirmed:" + this.sandbox);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    for (const check of [
      /Layer 1 Sandbox\s+Namespace/,
      /PID namespaces\s+Yes/,
      /Network namespaces\s+Yes/,
      /Seccomp-BPF sandbox\s+Yes/,
      /Seccomp-BPF sandbox supports TSYNC\s+Yes/,
    ]) {
      if (!check.test(this.sandbox))
        throw new Error("chromium-sandbox-unconfirmed:" + this.sandbox);
    }
    await this.bootstrapNavigate(await this.page(), "about:blank");
  }

  async bootstrapNavigate(page, url) {
    // 只在组件发布 ready 之前使用固定内部地址；模型不能调用此入口。
    let timer;
    const loaded = new Promise((resolve, reject) => {
      const event = (message) => {
        if (
          message.method === "Page.loadEventFired" &&
          message.sessionId === page.sessionId
        ) {
          cleanup();
          resolve();
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.connection.off("event", event);
      };
      this.connection.on("event", event);
      timer = setTimeout(() => {
        cleanup();
        reject(new Error("bootstrap-navigation-timeout"));
      }, 10000);
    });
    await Promise.all([
      loaded,
      this.connection.send(
        "Page.navigate",
        { url },
        { sessionId: page.sessionId },
      ),
    ]);
  }

  async page(permit) {
    const { targetInfos } = await this.connection.send(
      "Target.getTargets",
      {},
      { permit },
    );
    const pages = targetInfos.filter((t) => t.type === "page");
    const target = pages.find((t) => t.targetId === this.targetId) ?? pages[0];
    if (!target) throw new Error("browser-page-unavailable");
    this.targetId = target.targetId;
    let sessionId = this.sessions.get(target.targetId);
    if (!sessionId) {
      ({ sessionId } = await this.connection.send(
        "Target.attachToTarget",
        { targetId: target.targetId, flatten: true },
        { permit },
      ));
      this.sessions.set(target.targetId, sessionId);
      await this.connection.send("Page.enable", {}, { sessionId, permit });
      await this.connection.send("Network.enable", {}, { sessionId, permit });
    }
    const { frameTree } = await this.connection.send(
      "Page.getFrameTree",
      {},
      { sessionId, permit },
    );
    const frame = frameTree.frame;
    const { executionContextId } = await this.connection.send(
      "Page.createIsolatedWorld",
      {
        frameId: frame.id,
        worldName: "kaguya-dom-v1",
        grantUniveralAccess: false,
      },
      { sessionId, permit },
    );
    return {
      targetId: target.targetId,
      sessionId,
      frameId: frame.id,
      loaderId: frame.loaderId,
      executionContextId,
    };
  }

  async state(page, permit) {
    const result = await this.connection.send(
      "Runtime.evaluate",
      {
        expression: readDomExpression,
        contextId: page.executionContextId,
        returnByValue: true,
        awaitPromise: false,
      },
      { sessionId: page.sessionId, permit },
    );
    if (result.exceptionDetails || !result.result?.value)
      throw new Error("browser-dom-unconfirmed");
    return result.result.value;
  }

  validate(req) {
    const p = req.permit,
      env = req.environment;
    if (
      !p ||
      !env ||
      !["browser.observe", "browser.act", "browser.verify"].includes(
        req.toolName,
      ) ||
      this.service.mode !== "automation" ||
      this.service.closed ||
      p.environmentId !== this.service.environmentId ||
      p.generation !== this.service.generation ||
      p.operationId !== req.operationId ||
      p.attemptId !== req.attemptId ||
      p.digest !== req.digest ||
      !req.scope ||
      !p.leaseId ||
      !p.workflowId ||
      !p.fencing ||
      ["environmentId", "generation", "leaseId", "workflowId", "fencing"].some(
        (key) => p[key] !== env[key],
      )
    )
      throw new Error("invalid-browser-permit");
    return this.gate.permit(p.expiresAt);
  }

  observation(req, page, state) {
    const id = randomBytes(32).toString("hex");
    const ref = {
      id,
      environmentId: req.permit.environmentId,
      workflowId: req.permit.workflowId,
      generation: req.permit.generation,
    };
    const record = {
      ref,
      scope: req.scope,
      leaseId: req.permit.leaseId,
      fencing: req.permit.fencing,
      expires: Math.min(Date.parse(req.permit.expiresAt), Date.now() + 30000),
      page,
      expected: identity(state),
      contentHash: hash(JSON.stringify(identity(state))),
      nodes: state.nodes,
    };
    this.observations.set(id, record);
    for (const [key, value] of this.observations)
      if (value.expires <= Date.now() || this.observations.size > 64)
        this.observations.delete(key);
    return record;
  }

  current(req) {
    const ref = req.arguments.observation;
    const record = ref && this.observations.get(ref.id);
    if (
      !record ||
      Object.keys(ref).length !== 4 ||
      Object.entries(record.ref).some(([key, value]) => ref[key] !== value) ||
      record.scope !== req.scope ||
      record.leaseId !== req.permit.leaseId ||
      record.fencing !== req.permit.fencing ||
      record.expires <= Date.now() ||
      record.ref.generation !== this.service.generation
    )
      throw new Error("stale-browser-observation");
    return record;
  }

  async execute(req) {
    const permit = this.validate(req);
    if (!req.arguments || typeof req.arguments !== "object")
      throw new Error("invalid-browser-arguments");
    if (req.toolName === "browser.observe") return this.observe(req, permit);
    const record = this.current(req);
    const observedPermit = this.gate.permit(
      new Date(
        Math.min(record.expires, Date.parse(req.permit.expiresAt)),
      ).toISOString(),
    );
    if (req.toolName === "browser.act")
      return this.act(req, record, observedPermit);
    return this.verify(req, record, observedPermit);
  }

  async observe(req, permit) {
    const page = await this.page(permit);
    const state = await this.state(page, permit);
    permit.check();
    const record = this.observation(req, page, state);
    const artifacts = [];
    if (req.arguments.screenshot === true) {
      const screenshot = await this.connection.send(
        "Page.captureScreenshot",
        { format: "jpeg", quality: 70, captureBeyondViewport: false },
        { sessionId: page.sessionId, permit },
      );
      if (Buffer.byteLength(screenshot.data, "base64") > 16 * 1024 * 1024)
        throw new Error("screenshot-too-large");
      artifacts.push({ mime: "image/jpeg", dataBase64: screenshot.data });
    }
    return output(
      {
        observation: record.ref,
        pageId: page.targetId,
        documentId: page.loaderId,
        url: state.url,
        title: state.title,
        contentHash: record.contentHash,
        expiresAt: new Date(record.expires).toISOString(),
        viewport: state.viewport,
        text: state.text,
        nodes: state.nodes.map(({ selector, ...node }) => ({
          ...node,
          text: node.text.slice(0, 1024),
          value: node.value?.slice(0, 1024),
        })),
        downloads: [...this.downloads.values()].filter(
          (d) => d.scope === req.scope,
        ),
      },
      artifacts,
    );
  }

  async act(req, record, permit) {
    const args = req.arguments;
    if (!["navigate", "click", "fill", "select"].includes(args.action))
      throw new Error("unsupported-browser-action");
    let node;
    if (args.action === "navigate") {
      const url = new URL(args.url);
      if (
        !["http:", "https:"].includes(url.protocol) &&
        url.href !== "about:blank"
      )
        throw new Error("browser-url-denied");
      if (url.username || url.password)
        throw new Error("browser-url-credentials-denied");
    } else {
      node = record.nodes.find((item) => item.id === args.nodeId);
      if (!node?.visible || !node.inViewport || node.disabled)
        throw new Error("browser-node-unavailable");
      if (
        ["fill", "select"].includes(args.action) &&
        (typeof args.value !== "string" || args.value.length > 32768)
      )
        throw new Error("browser-value-invalid");
    }
    const page = await this.page(permit);
    if (
      page.targetId !== record.page.targetId ||
      page.loaderId !== record.page.loaderId
    )
      throw new Error("stale-browser-document");
    // 观察为一次性引用。无论后续回执是否到达，都不能再据此重发输入。
    this.observations.delete(record.ref.id);
    this.lastInput = {
      scope: req.scope,
      environmentId: req.permit.environmentId,
      workflowId: req.permit.workflowId,
      generation: req.permit.generation,
      operationId: req.operationId,
      attemptId: req.attemptId,
      frameId: page.frameId,
      controlEpoch: this.gate.epoch,
      deadline: Math.min(record.expires, Date.parse(req.permit.expiresAt)),
    };
    const result = await permit.send(() =>
      this.connection.send(
        "Runtime.callFunctionOn",
        {
          functionDeclaration: activateDomFunction,
          executionContextId: page.executionContextId,
          arguments: [
            {
              value: {
                action: args.action,
                selector: node?.selector,
                expectedBox: node?.box,
                value: args.value,
                url: args.url,
                expected: record.expected,
                deadline: Math.min(
                  record.expires,
                  Date.parse(req.permit.expiresAt),
                ),
              },
            },
          ],
          returnByValue: true,
          awaitPromise: false,
          userGesture: true,
        },
        { sessionId: page.sessionId, permit },
      ),
    );
    if (result.exceptionDetails || !result.result?.value)
      return output(
        {
          reason: "browser-input-outcome-unconfirmed",
          original: { operationId: req.operationId, attemptId: req.attemptId },
        },
        [],
        "unknown",
        "unconfirmed",
      );
    const value = result.result.value;
    return output(
      {
        ...value,
        original: { operationId: req.operationId, attemptId: req.attemptId },
        verificationRequired: true,
      },
      [],
      value.dispatched ? "succeeded" : "partial",
    );
  }

  async verify(req, record, permit) {
    const args = req.arguments;
    if (!args.original?.operationId || !args.original?.attemptId)
      throw new Error("original-operation-required");
    if (args.mode === "download") return this.exportDownload(req, permit);
    if (args.mode !== "page") throw new Error("invalid-browser-verification");
    const page = await this.page(permit);
    const state = await this.state(page, permit);
    if (
      page.targetId !== record.page.targetId ||
      page.loaderId !== record.page.loaderId ||
      hash(JSON.stringify(identity(state))) !== record.contentHash
    )
      throw new Error("stale-browser-observation");
    permit.check();
    const expected = args.expectation;
    let actual;
    if (expected?.kind === "url") actual = state.url;
    else {
      const node = state.nodes.find((item) => item.id === expected?.nodeId);
      if (!node) throw new Error("browser-node-unavailable");
      actual =
        expected.kind === "text"
          ? node.text
          : expected.kind === "value"
            ? node.value
            : expected.kind === "checked"
              ? node.checked
              : undefined;
    }
    if (
      expected?.kind === "checked"
        ? typeof actual !== "boolean" || typeof expected.equals !== "boolean"
        : typeof actual !== "string" || typeof expected?.equals !== "string"
    )
      throw new Error("invalid-browser-expectation");
    const matched = actual === expected.equals;
    return output(
      {
        original: args.original,
        verificationKind: "current-page-state",
        causalAttribution: "unconfirmed",
        matched,
        actual,
        expectation: expected,
        observedAt: new Date().toISOString(),
      },
      [],
      "succeeded",
      matched ? "verified" : "returned",
    );
  }

  event({ method, params }) {
    if (method === "Network.responseReceived") {
      this.responses.set(params.response.url, params.response.mimeType);
      if (this.responses.size > 256)
        this.responses.delete(this.responses.keys().next().value);
    } else if (method === "Browser.downloadWillBegin") {
      if (!uuid.test(params.guid)) return;
      const source =
        this.lastInput?.frameId === params.frameId &&
        this.service.mode === "automation" &&
        this.service.generation === this.lastInput.generation &&
        this.gate.epoch === this.lastInput.controlEpoch &&
        Date.now() < this.lastInput.deadline
          ? this.lastInput
          : undefined;
      const reportedMime = this.responses.get(params.url);
      const mime = [
        "image/png",
        "image/jpeg",
        "image/webp",
        "text/plain",
        "text/csv",
        "application/json",
        "application/pdf",
        "application/zip",
        "application/octet-stream",
        "video/webm",
      ].includes(reportedMime)
        ? reportedMime
        : "application/octet-stream";
      const metadata = {
        id: params.guid,
        sourceURL: params.url,
        suggestedFilename: params.suggestedFilename,
        mime,
        reportedMime,
        state: "in-progress",
        startedAt: new Date().toISOString(),
        correlation: source ? "latest-input-window" : "unattributed",
        association: source ? "heuristic" : "unattributed",
        causalAttribution: "unconfirmed",
        ...source,
      };
      this.downloads.set(params.guid, metadata);
    } else if (method === "Browser.downloadProgress") {
      const metadata = this.downloads.get(params.guid);
      if (
        !metadata ||
        metadata.state !== "in-progress" ||
        params.state === "inProgress"
      )
        return;
      if (params.state === "completed") {
        metadata.state = "archiving";
        const task = this.archiveDownload(metadata).catch(() => {
          metadata.state = "unconfirmed";
        });
        this.downloadTasks.add(task);
        void task.then(() => this.downloadTasks.delete(task));
      } else metadata.state = "cancelled";
    }
  }

  async archiveDownload(metadata) {
    const file = await open(
      join(this.root, "downloads", metadata.id),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error("download-not-regular");
      const hasher = createHash("sha256");
      for await (const chunk of file.createReadStream({ autoClose: false }))
        hasher.update(chunk);
      const after = await file.stat();
      if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs)
        throw new Error("download-changed");
      Object.assign(metadata, {
        state: "completed",
        size: stat.size,
        sha256: hasher.digest("hex"),
        completedAt: new Date().toISOString(),
      });
      const path = join(this.root, "downloads", metadata.id + ".json");
      await writeFile(path + ".tmp", JSON.stringify(metadata) + "\n", {
        mode: 0o600,
      });
      const receipt = await open(path + ".tmp", "r");
      try {
        await receipt.sync();
      } finally {
        await receipt.close();
      }
      await rename(path + ".tmp", path);
      const directory = await open(join(this.root, "downloads"), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await file.close();
    }
  }

  async exportDownload(req, permit) {
    const args = req.arguments;
    if (args.verificationKind !== "current-file-state")
      throw new Error("download-verification-kind-required");
    if (!uuid.test(args.downloadId)) throw new Error("download-id-invalid");
    await Promise.all([...this.downloadTasks]);
    const metadata = this.downloads.get(args.downloadId);
    if (
      !metadata ||
      metadata.state !== "completed" ||
      metadata.scope !== req.scope ||
      metadata.environmentId !== req.permit.environmentId ||
      metadata.operationId !== args.original.operationId ||
      metadata.attemptId !== args.original.attemptId ||
      metadata.sha256 !== args.sha256
    )
      throw new Error("download-original-mismatch");
    const offset = args.offset ?? 0,
      maxBytes = args.maxBytes ?? 16777216;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 16777216
    )
      throw new Error("download-range-invalid");
    const file = await open(
      join(this.root, "downloads", metadata.id),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== metadata.size)
        throw new Error("download-changed");
      const hasher = createHash("sha256");
      for await (const chunk of file.createReadStream({ autoClose: false }))
        hasher.update(chunk);
      if (hasher.digest("hex") !== metadata.sha256)
        throw new Error("download-changed");
      const buffer = Buffer.alloc(
        Math.min(maxBytes, Math.max(0, stat.size - offset)),
      );
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      permit.check();
      return {
        ...output(
          {
            original: args.original,
            verificationKind: "current-file-state",
            association: "heuristic",
            causalAttribution: "unconfirmed",
            download: metadata,
            offset,
            bytesReturned: bytesRead,
            complete: offset === 0 && bytesRead === stat.size,
          },
          bytesRead
            ? [
                {
                  mime: metadata.mime,
                  dataBase64: buffer.subarray(0, bytesRead).toString("base64"),
                },
              ]
            : [],
          "succeeded",
          "verified",
        ),
        truncated: offset + bytesRead < stat.size,
      };
    } finally {
      await file.close();
    }
  }

  async isolate() {
    this.observations.clear();
    this.lastInput = undefined;
    await this.gate.isolate();
    await this.connection.drain();
    return true;
  }

  async close() {
    await this.connection?.close();
  }
  identity() {
    return {
      kind: "chromium",
      connectionId: this.connection?.id,
      ownerPid: this.connection?.process.pid,
      version: this.version?.product,
      sandbox: this.sandbox,
      pending: this.connection
        ? [...this.connection.pending.values()].map(
            ({ method, sessionId }) => ({ method, sessionId }),
          )
        : [],
    };
  }
}
