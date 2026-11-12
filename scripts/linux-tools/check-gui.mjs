/**
 * 功能概述：GUI provider 的许可、一次性观察及双向排空合同测试，不连接模型或真实桌面。
 * 原子发布回归在 rename 前冻结写者，验证 ready 不提前出现、旧 ledger 完整且失败不覆盖。
 * drain 总预算回归用可控时钟确认阶段共享剩余时间、过期不派发、晚到结果不通过。
 * 主要职责：用显式 barrier 制造准备/发送/释放交错，核对零旧输入、未知结果不重放和 ACK 时点；模拟截图、输入与核对。
 * 代码库关系：直接调用 gui.mjs；实际 Cua/X11 行为继续由 check-gui-container.py 验证。
 * 输入输出与副作用：仅临时 HOME；复查原图/窗口/元素变化与接管交错；结束释放 barrier 并删除临时文件。
 */
import test from "node:test";
import { promises as fs } from "node:fs";
import { publishFixtureJson } from "./gui-fixture-json.mjs";
import { fixtureBudget } from "./gui-fixture-budget.mjs";
import { setImmediate as nextTurn } from "node:timers/promises";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { GuiComponent } from "./gui.mjs";

test("drain stages share one absolute budget and refuse expired dispatch", async () => {
  let now = 0;
  const limits = [];
  const stage = fixtureBudget(150000, {
    now: () => now,
    bound: (result, limit) => {
      limits.push(limit);
      return result;
    },
  });
  await stage(() => "started", 60000, "start");
  now = 140000;
  await stage(() => "observed", 25000, "observe");
  assert.deepEqual(limits, [60000, 10000]);
  now = 150000;
  let dispatched = false;
  assert.throws(
    () =>
      stage(
        () => {
          dispatched = true;
        },
        15000,
        "input",
      ),
    /total-deadline/,
  );
  assert.throws(stage.check, /total-deadline/);
  assert.equal(dispatched, false);
});

test("drain cannot accept a stage result after its absolute deadline", async () => {
  let now = 0;
  const stage = fixtureBudget(150000, {
    now: () => now,
    bound: (result) => result,
  });
  await assert.rejects(
    stage(
      () => {
        now = 150000;
        return "late";
      },
      150000,
      "late",
    ),
    /total-deadline/,
  );
});

const barrier = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);
const baseline = { keys: [], buttons: [], mapping: [[0]], per: 1 };
const target = { kind: "window", pid: 123, windowId: 456 };
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "kaguya-gui-"));
  const service = {
    home,
    environmentId: "env",
    generation: 0,
    mode: "automation",
    closed: false,
    instanceId: "service",
  };
  const state = {
    now: 1000000,
    input: [],
    stops: 0,
    resets: 0,
    drivers: [],
    value: "original",
    reads: 0,
  };
  const component = new GuiComponent({
    now: () => state.now,
    keyboard: async (request) => {
      if (request.mode === "snapshot") {
        state.baselineStarted?.resolve();
        await state.baselineWait?.promise;
        return baseline;
      }
      state.resets++;
      state.resetStarted?.resolve();
      await state.resetWait?.promise;
      if (state.failReset) throw new Error("release-unconfirmed");
      state.resetFinished = true;
      return { keys: [], buttons: [], restoredKeycodes: [], roundTrip: true };
    },
    driverFactory: () => {
      const driver = {
        start: async () => ({}),
        identity: () => ({ pid: 10 }),
        stop: async () => {
          state.stops++;
          state.pendingInput?.reject(new Error("driver-stopped"));
        },
        call: async (name, args, gate) => {
          if (name === "get_window_state" || name === "get_desktop_state") {
            if (name === "get_window_state")
              assert.equal(
                args.tree_format,
                "both",
                "fixed Cua markdown default omits structured elements",
              );
            state.reads++;
            if (state.reads > 1) {
              state.refreshStarted?.resolve();
              await state.refreshWait?.promise;
            }
            if (state.failRead) throw new Error("read-failed");
            const snapshotId = `s${state.reads.toString(16).padStart(8, "0")}`;
            const tree = state.emptyTree
              ? ""
              : `- [0] text "Input" value="${state.value}"`;
            return {
              content: [
                ...(state.reads > 1
                  ? [
                      {
                        type: "text",
                        text: "Invalidated snapshots s00000001: their element_tokens are stale.",
                      },
                    ]
                  : []),
                {
                  type: "text",
                  text: `window_id=456 pid=123 elements=1 walk_ms=${state.reads}\n\n${tree}`,
                },
                {
                  type: "image",
                  mimeType: "image/png",
                  data: (state.png ?? png).toString("base64"),
                },
              ],
              structuredContent: {
                capture_id: state.captureId ?? `capture-${state.reads}`,
                coordinate_frame: "window",
                screenshot_frame_valid: true,
                screenshot_width: 1,
                screenshot_height: 1,
                window_bounds: { x: state.x ?? 42, y: 43, width: 1, height: 1 },
                screen_width: 1,
                screen_height: 1,
                frame_scale: 1,
                windows: state.windows ?? [],
                pid: 123,
                window_id: 456,
                snapshot_id: snapshotId,
                tree_markdown: tree,
                elements: state.emptyTree
                  ? []
                  : [
                      {
                        index: 0,
                        value: state.value,
                        element_token: `${snapshotId}:0`,
                        selected: state.selected ?? true,
                      },
                    ],
                window_title: state.title ?? "fixture",
                popups: state.popups,
                walk_elapsed_ms: state.reads,
                invalidated_snapshot_ids: state.reads > 1 ? ["s00000001"] : [],
              },
            };
          }
          gate();
          state.input.push({ name, args });
          if (name === "set_value") state.value = args.value;
          if (name === "type_text") state.value += args.text;
          state.inputStarted?.resolve();
          if (state.pendingInput) return state.pendingInput.promise;
          return {
            structuredContent: {
              effect: state.effect ?? "confirmed",
              route: "accessibility",
            },
            content: [{ type: "text", text: "input receipt" }],
          };
        },
      };
      state.drivers.push(driver);
      return driver;
    },
  });
  await component.ready(service);
  t.after(async () => {
    state.refreshWait?.resolve();
    state.baselineWait?.resolve();
    state.resetWait?.resolve();
    try {
      await component.close();
    } catch (error) {
      if (!state.failReset) throw error;
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  let sequence = 0;
  const request = (toolName, args) => {
    const operationId = `operation-${++sequence}`;
    const environment = {
      environmentId: "env",
      generation: service.generation,
      leaseId: "lease",
      workflowId: "workflow",
      fencing: 1,
    };
    return {
      kind: service.mode === "human" ? "human-operation" : "operation",
      toolName,
      arguments: args,
      scope: "scope",
      environment,
      operationId,
      attemptId: "attempt",
      digest: "digest",
      permit: {
        ...environment,
        operationId,
        attemptId: "attempt",
        digest: "digest",
        expiresAt: new Date(state.now + 60000).toISOString(),
        ...(service.mode === "human"
          ? { audience: "human", humanSessionId: service.humanSessionId }
          : {}),
      },
    };
  };
  const observe = async () =>
    (await component.execute(request("gui.observe", { target }))).result
      .observation;
  const click = (observation) =>
    request("gui.act", {
      action: "click",
      observation,
      selector: { kind: "pixel", x: 0, y: 0 },
    });
  return { component, service, state, request, observe, click };
}

test("PNG bytes and window coordinates remain paired; input consumes its observation", async (t) => {
  const f = await fixture(t);
  const observed = await f.component.execute(
    f.request("gui.observe", { target }),
  );
  assert.deepEqual(
    Buffer.from(observed.artifacts[0].dataBase64, "base64"),
    png,
  );
  assert.equal(
    observed.result.image.sha256,
    createHash("sha256").update(png).digest("hex"),
  );
  assert.deepEqual(observed.result.image.origin, { x: 42, y: 43 });
  assert.equal(observed.result.image.coordinateFrame, "window");
  assert.equal(observed.result.image.scale, 1);
  const result = await f.component.execute(
    f.click(observed.result.observation),
  );
  assert.equal(result.status, "succeeded");
  assert.equal(f.state.input.length, 1);
  assert.equal(f.state.input[0].args.capture_id, "capture-2");
  assert.equal(result.result.captureId, "capture-1");
  assert.equal(result.result.revalidatedCaptureId, "capture-2");
  assert.equal(f.state.resets, 1);
  await assert.rejects(
    f.component.execute(f.click(observed.result.observation)),
    /stale-gui-observation/,
  );
  assert.equal(f.state.input.length, 1);
});

test("observe, input and fresh verification preserve the original operation identity", async (t) => {
  const f = await fixture(t);
  const before = await f.component.execute(
    f.request("gui.observe", { target }),
  );
  assert.match(before.result.text, /original/);
  const action = f.request("gui.act", {
    action: "replace",
    observation: before.result.observation,
    elementId: "e0",
    value: "updated",
  });
  const receipt = await f.component.execute(action);
  assert.equal(receipt.status, "succeeded");
  assert.equal(f.state.input.length, 1);
  await assert.rejects(
    f.component.execute(f.click(before.result.observation)),
    /stale-gui-observation/,
  );
  const original = {
    operationId: action.operationId,
    attemptId: action.attemptId,
  };
  const verified = await f.component.execute(
    f.request("gui.verify", {
      target,
      original,
      verificationKind: "current-gui-state",
      contains: "updated",
    }),
  );
  assert.deepEqual(verified.result.verification, {
    original,
    kind: "current-gui-state",
    matched: true,
  });
  assert.match(verified.result.text, /updated/);
  assert.equal(f.state.input.length, 1);
});

test("an empty capture identity cannot authorize a later input", async (t) => {
  const f = await fixture(t);
  f.state.captureId = "";
  await assert.rejects(f.observe(), /gui-capture-size-unconfirmed/);
  assert.equal(f.state.input.length, 0);
});

const pixel = { kind: "pixel", x: 0, y: 0 };
const actions = [
  { action: "click", selector: pixel },
  { action: "insert", selector: pixel, text: "hello" },
  { action: "scroll", selector: pixel, direction: "down", amount: 2 },
  { action: "key", key: "enter" },
  { action: "replace", elementId: "e0", value: "updated" },
];

test("all input kinds revalidate the original frame and use fresh driver tokens", async (t) => {
  for (const action of actions) {
    const f = await fixture(t),
      observation = await f.observe();
    const req = f.request("gui.act", { ...action, observation });
    const result = await f.component.execute(req);
    assert.equal(result.status, "succeeded", action.action);
    assert.equal(f.state.reads, 2);
    assert.equal(f.state.input.length, 1);
    assert.deepEqual(result.result.original, {
      operationId: req.operationId,
      attemptId: req.attemptId,
    });
    assert.equal(result.result.captureId, "capture-1");
    assert.equal(result.result.revalidatedCaptureId, "capture-2");
    if (action.action === "replace")
      assert.equal(f.state.input[0].args.element_token, "s00000002:0");
    if (action.selector) {
      assert.equal(f.state.input[0].args.x, 0);
      assert.equal(f.state.input[0].args.y, 0);
      assert.equal(f.state.input[0].args.coordinate_frame, "window");
    }
  }
});

test("window movement, changed pixels or changed element text invalidate every old action", async (t) => {
  for (const change of [
    "position",
    "pixels",
    "text",
    "selection",
    "title",
    "popup",
    "read-error",
  ]) {
    for (const action of actions) {
      const f = await fixture(t),
        observation = await f.observe();
      if (change === "position") f.state.x = 43;
      if (change === "text") f.state.value = "changed externally";
      if (change === "selection") f.state.selected = false;
      if (change === "title") f.state.title = "another window";
      if (change === "popup") f.state.popups = [{ window_id: 789 }];
      if (change === "pixels") {
        // 另一幅有效的一像素 PNG；尺寸不变，内容不同。
        f.state.png = Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        );
      }
      if (change === "read-error") f.state.failRead = true;
      const result = await f.component.execute(
        f.request("gui.act", { ...action, observation }),
      );
      assert.equal(result.status, "unknown");
      assert.equal(
        result.result.reason,
        change === "read-error"
          ? "gui-input-unconfirmed"
          : "stale-gui-observation",
      );
      assert.equal(f.state.input.length, 0, `${change}:${action.action}`);
      assert.equal(f.state.resets, 1);
      await assert.rejects(
        f.component.execute(f.click(observation)),
        /stale-gui-observation/,
      );
    }
  }
});

test("desktop window identity changes invalidate a pixel scroll even when pixels match", async (t) => {
  const f = await fixture(t);
  const observation = (
    await f.component.execute(
      f.request("gui.observe", { target: { kind: "desktop" } }),
    )
  ).result.observation;
  f.state.windows = [{ pid: 999, window_id: 456 }];
  const result = await f.component.execute(
    f.request("gui.act", {
      action: "scroll",
      selector: pixel,
      direction: "down",
      observation,
    }),
  );
  assert.equal(result.result.reason, "stale-gui-observation");
  assert.equal(f.state.input.length, 0);
});

test("an unchanged window with no accessible elements still supports pixel input", async (t) => {
  const f = await fixture(t);
  f.state.emptyTree = true;
  const observation = await f.observe();
  const result = await f.component.execute(
    f.request("gui.act", {
      action: "insert",
      selector: pixel,
      text: "hello",
      observation,
    }),
  );
  assert.equal(result.status, "succeeded");
  assert.equal(f.state.input.length, 1);
  assert.equal(f.state.value, "originalhello");
});

test("desktop keyboard input requires an explicit window observation", async (t) => {
  const f = await fixture(t);
  const observation = (
    await f.component.execute(
      f.request("gui.observe", { target: { kind: "desktop" } }),
    )
  ).result.observation;
  for (const action of [
    { action: "insert", selector: pixel, text: "hello" },
    { action: "key", key: "enter" },
  ]) {
    await assert.rejects(
      f.component.execute(f.request("gui.act", { ...action, observation })),
      /gui-window-observation-required/,
    );
  }
  assert.equal(f.state.input.length, 0);
});

test(
  "cancellation, expiry and takeover during revalidation prevent late input and permit fresh recovery",
  { timeout: 5000 },
  async (t) => {
    for (const transition of ["cancel", "expiry", "takeover"]) {
      const f = await fixture(t),
        observation = await f.observe();
      f.state.refreshStarted = barrier();
      f.state.refreshWait = barrier();
      const action = f.component.execute(
        f.request("gui.act", {
          action: "insert",
          selector: pixel,
          text: "hello",
          observation,
        }),
      );
      await f.state.refreshStarted.promise;
      await assert.rejects(f.observe(), /gui-operation-in-flight/);
      let isolation;
      try {
        if (transition === "expiry") f.state.now += 30001;
        else {
          f.service.mode = "draining";
          isolation = f.component.isolate();
        }
      } finally {
        f.state.refreshWait.resolve();
      }
      assert.equal((await action).status, "unknown");
      await isolation;
      assert.equal(f.state.input.length, 0);
      assert.equal(f.state.resets, 1);
      f.service.generation++;
      f.service.mode = "automation";
      await assert.rejects(
        f.component.execute(f.click(observation)),
        /stale-gui-observation/,
      );
      const fresh = await f.observe();
      assert.equal(
        (await f.component.execute(f.click(fresh))).status,
        "succeeded",
      );
      assert.equal(f.state.input.length, 1);
    }
  },
);

test("expired capture, changed lease, wrong generation and unsupported actions send nothing", async (t) => {
  for (const kind of ["expiry", "lease", "generation", "outside", "launch"]) {
    const f = await fixture(t),
      observation = await f.observe(),
      request = f.click(observation);
    if (kind === "expiry") f.state.now += 30001;
    if (kind === "lease") {
      request.permit.leaseId = "replacement";
      request.environment.leaseId = "replacement";
    }
    if (kind === "generation") f.service.generation++;
    if (kind === "outside") request.arguments.selector.x = 1;
    if (kind === "launch")
      request.arguments = {
        observation,
        action: "launch_app",
        command: "ignored",
      };
    await assert.rejects(f.component.execute(request));
    assert.equal(f.state.input.length, 0, kind);
  }
});

test("a replacement permit cannot reuse another workflow or generation observation", async (t) => {
  for (const key of [
    "workflowId",
    "generation",
    "fencing",
    "scope",
    "operationId",
    "attemptId",
    "digest",
  ]) {
    const f = await fixture(t),
      observation = await f.observe();
    if (key === "generation") f.service.generation++;
    const req = f.click(observation);
    if (key === "workflowId" || key === "fencing") {
      req.permit[key] = key === "fencing" ? 2 : "different-workflow";
      req.environment[key] = req.permit[key];
    } else if (key === "scope") req.scope = "different-scope";
    else if (key !== "generation") req[key] = "not-the-permitted-operation";
    await assert.rejects(f.component.execute(req));
    assert.equal(f.state.input.length, 0, key);
  }
});

test(
  "cancellation after typing preserves the effect and verifies without resending",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t),
      observation = await f.observe();
    f.state.pendingInput = barrier();
    f.state.inputStarted = barrier();
    const req = f.request("gui.act", {
      action: "insert",
      selector: pixel,
      text: " once",
      observation,
    });
    const pending = f.component.execute(req);
    await f.state.inputStarted.promise;
    f.service.mode = "draining";
    await f.component.isolate();
    const receipt = await pending;
    assert.equal(receipt.status, "unknown");
    assert.equal(f.state.value, "original once");
    assert.equal(f.state.resets, 1);
    f.service.generation++;
    f.service.mode = "automation";
    f.state.pendingInput = undefined;
    const verified = await f.component.execute(
      f.request("gui.verify", {
        target,
        original: receipt.result.original,
        verificationKind: "current-gui-state",
        contains: "original once",
      }),
    );
    assert.equal(verified.result.verification.matched, true);
    assert.deepEqual(verified.result.verification.original, {
      operationId: req.operationId,
      attemptId: req.attemptId,
    });
    assert.equal(f.state.input.length, 1);
    await assert.rejects(
      f.component.execute(f.click(observation)),
      /stale-gui-observation/,
    );
  },
);

test("handoff during baseline preparation fences the final stdin send", async (t) => {
  const f = await fixture(t),
    observation = await f.observe();
  f.state.baselineStarted = barrier();
  f.state.baselineWait = barrier();
  const action = f.component.execute(f.click(observation));
  await f.state.baselineStarted.promise;
  f.service.mode = "draining";
  const handoff = f.component.isolate();
  f.state.baselineWait.resolve();
  assert.equal((await action).status, "unknown");
  assert.equal(await handoff, true);
  assert.equal(f.state.input.length, 0);
});

test("both audiences wait for input release before handoff acknowledgement", async (t) => {
  for (const audience of ["automation", "human"]) {
    const f = await fixture(t);
    f.service.mode = audience;
    f.service.humanSessionId = "human-session";
    const observation = await f.observe();
    f.state.pendingInput = barrier();
    f.state.inputStarted = barrier();
    f.state.resetStarted = barrier();
    f.state.resetWait = barrier();
    const action = f.component.execute(f.click(observation));
    await f.state.inputStarted.promise;
    f.service.mode = "draining";
    let acknowledged = false;
    const handoff = f.component.isolate().then(() => {
      assert.equal(
        f.state.resetFinished,
        true,
        "ACK must follow reset completion",
      );
      acknowledged = true;
    });
    try {
      await f.state.resetStarted.promise;
      await nextTurn();
      assert.equal(acknowledged, false);
    } finally {
      f.state.resetWait.resolve();
    }
    await handoff;
    assert.equal((await action).status, "unknown");
    assert.equal(f.state.input.length, 1);
  }
});

test("unconfirmed release never acknowledges isolation or starts a new driver", async (t) => {
  const f = await fixture(t),
    observation = await f.observe();
  f.state.failReset = true;
  await assert.rejects(
    f.component.execute(f.click(observation)),
    /release-unconfirmed/,
  );
  await assert.rejects(f.component.isolate(), /release-unconfirmed/);
  await assert.rejects(f.observe(), /gui-drain-unconfirmed/);
  assert.equal(f.state.drivers.length, 1);
});

test("unverifiable Cua result stays unknown and is never resent", async (t) => {
  const f = await fixture(t),
    observation = await f.observe();
  f.state.effect = "unverifiable";
  assert.equal(
    (await f.component.execute(f.click(observation))).status,
    "unknown",
  );
  await assert.rejects(
    f.component.execute(f.click(observation)),
    /stale-gui-observation/,
  );
  assert.equal(f.state.input.length, 1);
});

test(
  "fixture JSON becomes visible only at the publication barrier",
  { timeout: 5000 },
  async (t) => {
    for (const previous of [undefined, { count: 0 }]) {
      await t.test(
        previous
          ? "keeps the prior ledger"
          : "does not publish empty readiness",
        async (t) => {
          const root = await mkdtemp(join(tmpdir(), "kaguya-gui-publication-"));
          t.after(() => rm(root, { recursive: true, force: true }));
          const path = join(root, "fixture.json");
          if (previous) await publishFixtureJson(path, previous);
          const entered = barrier(),
            release = barrier();
          const rename = fs.rename;
          t.mock.method(fs, "rename", async (...args) => {
            if (args[1] === path) {
              entered.resolve();
              await release.promise;
            }
            return rename(...args);
          });
          const current = { uid: 1001, pid: 42, count: 1 };
          const pending = publishFixtureJson(path, current);
          try {
            await Promise.race([
              entered.promise,
              pending.then(() => {
                throw new Error("publication bypassed barrier");
              }),
            ]);
            assert.deepEqual(
              JSON.parse(await fs.readFile(`${path}.pending`, "utf8")),
              current,
            );
            if (previous)
              assert.deepEqual(
                JSON.parse(await fs.readFile(path, "utf8")),
                previous,
              );
            else await assert.rejects(fs.readFile(path), { code: "ENOENT" });
          } finally {
            release.resolve();
            await pending;
          }
          assert.deepEqual(
            JSON.parse(await fs.readFile(path, "utf8")),
            current,
          );
          await assert.rejects(fs.stat(`${path}.pending`), { code: "ENOENT" });
        },
      );
    }
  },
);

test("failed fixture publication preserves the complete previous ledger", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kaguya-gui-publication-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "fixture.json");
  await publishFixtureJson(path, { count: 0 });
  const rename = fs.rename;
  t.mock.method(fs, "rename", async (...args) => {
    if (args[1] === path) throw new Error("synthetic publication failure");
    return rename(...args);
  });
  await assert.rejects(
    publishFixtureJson(path, { count: 1 }),
    /synthetic publication failure/,
  );
  assert.deepEqual(JSON.parse(await fs.readFile(path, "utf8")), { count: 0 });
});
