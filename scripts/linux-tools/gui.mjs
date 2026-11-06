/**
 * 功能概述：可信 GUI provider，将有期限的桌面观察映射为一次 Cua 输入，保留应用进程。
 * 主要职责：GuiComponent 检查 scope/许可/代际/会话；最终 stdin.write 前同步复查，
 * 每次输入前重读同一目标并比较原图、坐标框与文本，只有状态一致才换用新 snapshot token；
 * isolate 先撤销观察，再终止 Driver 组、释放真实 X11 输入并读回，完成后才确认排空。
 * 代码库关系：ToolService 分派 gui.observe/act/verify；broker 保存操作身份与不可变 PNG，
 * CuaStdio 禁止程序启动及任意 MCP；gui-x11.py 是固定可信状态收尾入口。
 * 输入输出与副作用：截图保持原尺寸并声明窗口原点/坐标空间，拒绝空 capture ID；未知输入不重发，关闭不杀应用。
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { CuaStdio } from "./cua-stdio.mjs";
import { x11State } from "./gui-x11.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const keys = (value, required, optional = []) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    required.some((key) => !(key in value)) ||
    Object.keys(value).some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  )
    throw new Error("invalid-gui-arguments");
};
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const textOf = (value) =>
  value.content
    ?.filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n") ?? "";
const output = (
  result,
  artifacts = [],
  status = "succeeded",
  truncated = false,
) => ({
  status,
  evidence: status === "succeeded" ? "returned" : "unconfirmed",
  result,
  artifacts,
  truncated,
});
function target(value) {
  if (value?.kind === "desktop") keys(value, ["kind"]);
  else {
    keys(value, ["kind", "pid", "windowId"]);
    if (
      value.kind !== "window" ||
      !positive(value.pid) ||
      !positive(value.windowId)
    )
      throw new Error("invalid-gui-target");
  }
  return structuredClone(value);
}
function capture(result, where) {
  if (result.isError) throw new Error("gui-observation-unconfirmed");
  const images = result.content?.filter((item) => item.type === "image") ?? [];
  if (
    images.length !== 1 ||
    images[0].mimeType !== "image/png" ||
    typeof images[0].data !== "string"
  )
    throw new Error("gui-png-required");
  const bytes = Buffer.from(images[0].data, "base64");
  if (
    bytes.length < 24 ||
    bytes.length > 16 * 1024 ** 2 ||
    bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
  )
    throw new Error("gui-png-invalid");
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20),
    data = result.structuredContent;
  if (
    !positive(width) ||
    !positive(height) ||
    width > 1280 ||
    height > 800 ||
    data?.screenshot_width !== width ||
    data?.screenshot_height !== height ||
    typeof data?.capture_id !== "string" ||
    !data.capture_id
  )
    throw new Error("gui-capture-size-unconfirmed");
  let origin = { x: 0, y: 0 };
  if (where.kind === "window") {
    const bounds = data.window_bounds;
    if (
      data.pid !== where.pid ||
      data.window_id !== where.windowId ||
      data.coordinate_frame !== "window" ||
      data.screenshot_frame_valid !== true ||
      bounds?.width !== width ||
      bounds?.height !== height ||
      !Number.isSafeInteger(bounds?.x) ||
      !Number.isSafeInteger(bounds?.y)
    )
      throw new Error("gui-window-frame-unconfirmed");
    origin = { x: bounds.x, y: bounds.y };
  } else if (
    data.screen_width !== width ||
    data.screen_height !== height ||
    data.frame_scale !== 1
  )
    throw new Error("gui-desktop-frame-unconfirmed");
  return {
    bytes,
    data,
    geometry: {
      captureId: data.capture_id,
      coordinateFrame: where.kind,
      width,
      height,
      originalWidth: width,
      originalHeight: height,
      scale: 1,
      origin,
      target: where,
      sha256: hash(bytes),
      mime: "image/png",
    },
  };
}

// Cua 文本包含 walk_ms、snapshot_id 与旧 token 提示；这些驱动元数据会随读取改变。
// 比较结构化语义字段，保留元素状态、顺序、窗口层级及覆盖层；只去掉元素自己的 token。
function fingerprint(image) {
  const { captureId: _captureId, ...geometry } = image.geometry;
  const data = image.data;
  const elements = data.elements?.map(
    ({ element_token: _token, ...element }) => element,
  );
  if (
    geometry.target.kind === "window" &&
    (typeof data.tree_markdown !== "string" || !Array.isArray(elements))
  )
    throw new Error("gui-window-state-unconfirmed");
  return hash(
    JSON.stringify({
      geometry,
      tree: data.tree_markdown,
      elements,
      windows: data.windows,
      appName: data.app_name,
      windowTitle: data.window_title,
      dialogs: data.dialogs,
      popups: data.popups,
      followUp: data.follow_up,
      composited: data.screenshot_composited,
      elementCount: data.element_count,
      totalElementCount: data.total_element_count,
      returnedElementCount: data.returned_element_count,
      elementsComplete: data.elements_complete,
      boundsComplete: data.bounds_complete,
      truncated: data.truncated === true,
      truncationReason: data.truncation_reason,
    }),
  );
}
function elementsOf(image, text) {
  if (
    image.geometry.target.kind !== "window" ||
    !/^s[0-9a-f]{8}$/.test(image.data.snapshot_id)
  )
    return [];
  return text.split("\n").flatMap((line) => {
    const index = /^\s*- \[(\d+)\]/.exec(line)?.[1];
    return index === undefined
      ? []
      : [
          {
            id: `e${index}`,
            token: `${image.data.snapshot_id}:${index}`,
            description: line.trim().slice(0, 160),
          },
        ];
  });
}

export class GuiComponent {
  constructor({
    driverFactory = () => new CuaStdio(),
    keyboard = x11State,
    now = Date.now,
  } = {}) {
    this.driverFactory = driverFactory;
    this.keyboard = keyboard;
    this.now = now;
    this.epoch = 0;
    this.observations = new Map();
    this.capabilities = ["gui.observe", "gui.act", "gui.verify"];
    this.supportsHuman = true;
  }
  async ready(service) {
    this.service = service;
    await mkdir(`${service.home}/runtime`, { recursive: true, mode: 0o700 });
  }
  validate(req) {
    const p = req.permit,
      env = req.environment,
      epoch = this.epoch;
    const audience = p?.audience ?? "automation";
    const check = () => {
      if (
        epoch !== this.epoch ||
        this.service.closed ||
        !this.capabilities.includes(req.toolName) ||
        !p ||
        !env ||
        !req.scope ||
        p.environmentId !== this.service.environmentId ||
        p.generation !== this.service.generation ||
        p.operationId !== req.operationId ||
        p.attemptId !== req.attemptId ||
        p.digest !== req.digest ||
        !p.leaseId ||
        !p.workflowId ||
        !p.fencing ||
        [
          "environmentId",
          "generation",
          "leaseId",
          "workflowId",
          "fencing",
        ].some((key) => p[key] !== env[key]) ||
        !Number.isFinite(Date.parse(p.expiresAt)) ||
        this.now() >= Date.parse(p.expiresAt)
      )
        throw new Error("gui-input-fenced");
      if (audience === "automation") {
        if (this.service.mode !== "automation" || req.kind !== "operation")
          throw new Error("gui-input-fenced");
      } else if (
        audience !== "human" ||
        this.service.mode !== "human" ||
        req.kind !== "human-operation" ||
        !p.humanSessionId ||
        p.humanSessionId !== this.service.humanSessionId
      )
        throw new Error("gui-input-fenced");
    };
    check();
    return check;
  }
  async connection(check) {
    check();
    let record = this.active;
    if (record?.closed) throw new Error("gui-drain-unconfirmed");
    if (!record) {
      record = {
        driver: this.driverFactory(),
        id: randomBytes(16).toString("hex"),
        symbols: new Set(),
        closed: false,
      };
      this.active = record;
      record.ready = record.driver.start();
    }
    await record.ready;
    check();
    if (record.closed || this.active !== record)
      throw new Error("gui-input-fenced");
    return record;
  }
  execute(req) {
    if (this.inflight)
      return Promise.reject(new Error("gui-operation-in-flight"));
    const work = this.run(req);
    this.inflight = work;
    return work.finally(() => {
      if (this.inflight === work) this.inflight = undefined;
    });
  }
  async run(req) {
    const check = this.validate(req);
    if (req.toolName === "gui.act") return this.act(req, check);
    if (req.toolName === "gui.observe") keys(req.arguments, ["target"]);
    else {
      keys(req.arguments, [
        "target",
        "original",
        "verificationKind",
        "contains",
      ]);
      keys(req.arguments.original, ["operationId", "attemptId"]);
      if (
        req.arguments.verificationKind !== "current-gui-state" ||
        typeof req.arguments.contains !== "string" ||
        !req.arguments.contains ||
        req.arguments.contains.length > 4096
      )
        throw new Error("invalid-gui-verification");
    }
    const observed = await this.observe(req, check);
    if (req.toolName === "gui.verify")
      observed.result.verification = {
        original: req.arguments.original,
        kind: "current-gui-state",
        matched: observed.result.text.includes(req.arguments.contains),
      };
    return observed;
  }
  async observe(req, check) {
    const where = target(req.arguments.target);
    const record = await this.connection(check);
    this.observations.clear();
    check();
    const result = await record.driver.call(
      where.kind === "desktop" ? "get_desktop_state" : "get_window_state",
      where.kind === "desktop"
        ? { max_image_dimension: 0 }
        : {
            pid: where.pid,
            window_id: where.windowId,
            max_image_dimension: 0,
            tree_format: "both",
          },
    );
    check();
    const image = capture(result, where),
      allText = textOf(result);
    const elements = elementsOf(image, allText);
    const ref = {
      id: randomBytes(32).toString("hex"),
      environmentId: req.permit.environmentId,
      workflowId: req.permit.workflowId,
      generation: req.permit.generation,
    };
    const expires = Math.min(
      Date.parse(req.permit.expiresAt),
      this.now() + 30000,
    );
    const observation = {
      ref,
      scope: req.scope,
      leaseId: req.permit.leaseId,
      fencing: req.permit.fencing,
      audience: req.permit.audience ?? "automation",
      humanSessionId: req.permit.humanSessionId,
      record,
      image: image.geometry,
      fingerprint: fingerprint(image),
      elements: elements.slice(0, 100),
      expires,
    };
    this.observations.set(ref.id, observation);
    const windows =
      where.kind === "desktop" && Array.isArray(image.data.windows)
        ? image.data.windows.slice(0, 32).map((window) => ({
            pid: window.pid,
            windowId: window.window_id,
            title: String(window.title ?? "").slice(0, 512),
            bounds: window.bounds,
          }))
        : undefined;
    return output(
      {
        observation: ref,
        expiresAt: new Date(expires).toISOString(),
        image: {
          ...image.geometry,
          capturedAt: new Date(this.now()).toISOString(),
          serviceInstanceId: this.service.instanceId,
          driverInstanceId: record.id,
        },
        text: allText.slice(0, 24000),
        elements: observation.elements.map(({ token, ...element }) => element),
        windows,
      },
      [{ mime: "image/png", dataBase64: image.bytes.toString("base64") }],
      "succeeded",
      allText.length > 24000 ||
        elements.length > 100 ||
        image.data.truncated === true ||
        (image.data.windows?.length ?? 0) > 32,
    );
  }
  current(req, check) {
    check();
    const ref = req.arguments?.observation;
    keys(ref, ["id", "environmentId", "workflowId", "generation"]);
    const observation = this.observations.get(ref.id);
    if (
      !observation ||
      Object.entries(observation.ref).some(
        ([key, value]) => ref[key] !== value,
      ) ||
      ["environmentId", "workflowId", "generation"].some(
        (key) => observation.ref[key] !== req.permit[key],
      ) ||
      observation.scope !== req.scope ||
      observation.leaseId !== req.permit.leaseId ||
      observation.fencing !== req.permit.fencing ||
      observation.audience !== (req.permit.audience ?? "automation") ||
      observation.humanSessionId !== req.permit.humanSessionId ||
      observation.expires <= this.now() ||
      observation.record !== this.active ||
      observation.record.closed
    )
      throw new Error("stale-gui-observation");
    return observation;
  }
  async refresh(observation, check) {
    check();
    const where = observation.image.target;
    const result = await observation.record.driver.call(
      where.kind === "desktop" ? "get_desktop_state" : "get_window_state",
      where.kind === "desktop"
        ? { max_image_dimension: 0 }
        : {
            pid: where.pid,
            window_id: where.windowId,
            max_image_dimension: 0,
            tree_format: "both",
          },
    );
    check();
    const image = capture(result, where),
      text = textOf(result);
    if (fingerprint(image) !== observation.fingerprint)
      throw new Error("stale-gui-observation");
    // 不发布新观察，不延长期限，不改变冻结原图；仅使用已核对状态的最新驱动 token。
    return {
      ...observation,
      image: image.geometry,
      elements: elementsOf(image, text).slice(0, 100),
    };
  }
  input(args, observation) {
    const where = observation.image.target;
    const base =
      where.kind === "desktop"
        ? { scope: "desktop", delivery_mode: "foreground" }
        : {
            pid: where.pid,
            window_id: where.windowId,
            delivery_mode: "foreground",
          };
    const element = (id) => {
      const found = observation.elements.find((entry) => entry.id === id);
      if (!found) throw new Error("gui-element-unavailable");
      return { element_token: found.token };
    };
    const select = (value) => {
      if (value?.kind === "element") {
        keys(value, ["kind", "elementId"]);
        return element(value.elementId);
      }
      keys(value, ["kind", "x", "y"]);
      if (
        value.kind !== "pixel" ||
        !Number.isSafeInteger(value.x) ||
        !Number.isSafeInteger(value.y) ||
        value.x < 0 ||
        value.y < 0 ||
        value.x >= observation.image.width ||
        value.y >= observation.image.height
      )
        throw new Error("gui-coordinate-outside-capture");
      return { x: value.x, y: value.y, coordinate_frame: where.kind };
    };
    if (args.action === "click") {
      keys(args, ["action", "observation", "selector"], ["button"]);
      const button = args.button ?? "left";
      if (!["left", "middle", "right"].includes(button))
        throw new Error("gui-button-denied");
      const selected = select(args.selector);
      return [
        "click",
        {
          ...base,
          ...selected,
          button,
          ...(args.selector.kind === "pixel"
            ? { capture_id: observation.image.captureId }
            : {}),
        },
      ];
    }
    if (args.action === "insert") {
      // Cua 0.38 桌面 type_text 忽略 x/y；必须先观察目标窗口，禁止向隐式焦点插入。
      if (where.kind !== "window")
        throw new Error("gui-window-observation-required");
      keys(args, ["action", "observation", "selector", "text"]);
      if (
        typeof args.text !== "string" ||
        !args.text ||
        args.text.length > 4096 ||
        !/^[\x09\x0a\x0d\x20-\x7e]+$/.test(args.text)
      )
        throw new Error("gui-insert-ascii-required");
      return [
        "type_text",
        { ...base, ...select(args.selector), text: args.text },
      ];
    }
    if (args.action === "replace") {
      keys(args, ["action", "observation", "elementId", "value"]);
      if (typeof args.value !== "string" || args.value.length > 4096)
        throw new Error("gui-value-invalid");
      for (const char of args.value) {
        const code = char.codePointAt(0);
        observation.record.symbols.add(code <= 255 ? code : 0x01000000 + code);
      }
      return [
        "set_value",
        { ...base, ...element(args.elementId), value: args.value },
      ];
    }
    if (args.action === "key") {
      // 桌面截图不声明输入焦点；窗口级按键由明确的 pid/window_id 路由。
      if (where.kind !== "window")
        throw new Error("gui-window-observation-required");
      keys(args, ["action", "observation", "key"], ["modifiers"]);
      const modifiers = args.modifiers ?? [];
      if (
        typeof args.key !== "string" ||
        !/^(?:[ -~]|enter|tab|escape|space|backspace|delete|insert|home|end|pageup|pagedown|up|down|left|right|f(?:[1-9]|1[0-2]))$/.test(
          args.key,
        ) ||
        !Array.isArray(modifiers) ||
        modifiers.length > 4 ||
        modifiers.some((m) => !["ctrl", "shift", "alt", "super"].includes(m))
      )
        throw new Error("gui-key-denied");
      return ["press_key", { ...base, key: args.key, modifiers }];
    }
    if (args.action === "scroll") {
      keys(
        args,
        ["action", "observation", "selector", "direction"],
        ["amount"],
      );
      const amount = args.amount ?? 3;
      if (
        !["up", "down"].includes(args.direction) ||
        !Number.isSafeInteger(amount) ||
        amount < 1 ||
        amount > 10
      )
        throw new Error("gui-scroll-denied");
      return [
        "scroll",
        {
          ...base,
          ...select(args.selector),
          direction: args.direction,
          amount,
        },
      ];
    }
    throw new Error("gui-action-denied");
  }
  async act(req, check) {
    const observation = this.current(req, check),
      record = observation.record;
    this.input(req.arguments, observation);
    this.observations.delete(observation.ref.id);
    record.preparingBaseline = this.keyboard({ mode: "snapshot" }).then(
      (value) => {
        record.baseline = value;
      },
    );
    const finalCheck = () => {
      check();
      if (
        record.closed ||
        this.active !== record ||
        this.now() >= observation.expires
      )
        throw new Error("gui-input-fenced");
    };
    const timeout = setTimeout(
      () => {
        void this.drain(record).catch(() => {});
      },
      Math.max(
        0,
        Math.min(observation.expires, Date.parse(req.permit.expiresAt)) -
          this.now(),
      ),
    );
    let result, refreshed;
    try {
      await record.preparingBaseline;
      finalCheck();
      refreshed = await this.refresh(observation, finalCheck);
      const [name, args] = this.input(req.arguments, refreshed);
      result = await record.driver.call(name, args, finalCheck);
    } catch (error) {
      return output(
        {
          reason:
            error?.message === "stale-gui-observation"
              ? "stale-gui-observation"
              : "gui-input-unconfirmed",
          original: { operationId: req.operationId, attemptId: req.attemptId },
          captureId: observation.image.captureId,
        },
        [],
        "unknown",
      );
    } finally {
      clearTimeout(timeout);
      await this.drain(record);
    }
    const effect = result.structuredContent?.effect;
    return output(
      {
        original: { operationId: req.operationId, attemptId: req.attemptId },
        captureId: observation.image.captureId,
        revalidatedCaptureId: refreshed.image.captureId,
        effect: effect ?? "unverifiable",
        route: result.structuredContent?.route,
        text: textOf(result).slice(0, 4096),
      },
      [],
      !result.isError && effect === "confirmed" ? "succeeded" : "unknown",
    );
  }
  drain(record) {
    if (!record) return Promise.resolve(true);
    if (record.draining) return record.draining;
    this.epoch++;
    this.observations.clear();
    record.closed = true;
    const work = (async () => {
      await record.driver.stop();
      await record.ready.catch(() => {});
      await record.preparingBaseline;
      if (record.baseline)
        await this.keyboard({
          mode: "reset",
          before: record.baseline,
          expectedKeysyms: [...record.symbols],
        });
      if (this.active === record) this.active = undefined;
      return true;
    })();
    record.draining = work;
    return work;
  }
  async isolate() {
    this.epoch++;
    this.observations.clear();
    await this.drain(this.active);
    await this.inflight?.catch(() => {});
    return true;
  }
  close() {
    return this.isolate();
  }
  identity() {
    return {
      kind: "gui",
      transport: "private-stdio",
      driver: this.active?.driver.identity(),
      draining: this.active?.closed === true,
    };
  }
}
