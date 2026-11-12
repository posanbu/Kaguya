/**
 * 功能概述：真实 Cua 输入被中断后的 Driver 组退出及 X11 held/映射收尾验收。
 * 主要职责：CI 私有代理逐帧转发一次真实输入，在目标请求后阻塞后续请求；真实状态确认并停止整组后 kill，再 release/readback。
 * 代码库关系：gui-interrupt-probe.py 提供确定中断边界，gui-x11.py 是固定可信收尾入口。
 * 输入输出与副作用：只向隔离合成终端输入未执行字符，不按 Enter；不结束应用，不调用模型。
 */
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  writeFile as rawWriteFile,
  readFile as rawReadFile,
} from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { CuaStdio } from "./cua-stdio.mjs";
const exec = promisify(execFile);
import { x11State as rawKeyboard } from "./gui-x11.mjs";

import { bounded, fixtureBudget } from "./gui-fixture-budget.mjs";
// 四模式共用 150 秒，finally 的并行 monitor/driver/helper 收尾最多 10 秒；外层 180 秒还留 20 秒。
const stage = fixtureBudget(150000);
const pendingHelpers = new Set();
const keyboard = (request) =>
  stage(
    () => {
      const pending = rawKeyboard(request);
      pendingHelpers.add(pending);
      pending.finally(() => pendingHelpers.delete(pending)).catch(() => {});
      return pending;
    },
    5000,
    "x11-stage-timeout",
  );
const readFile = (...args) =>
  stage(() => rawReadFile(...args), 5000, "fixture-read-timeout");
const writeFile = (...args) =>
  stage(() => rawWriteFile(...args), 5000, "fixture-write-timeout");

for (const mode of ["held", "modifier", "button", "unicode"]) {
  const displays = { held: 91, modifier: 92, button: 93, unicode: 94 };
  let monitor;
  const driver = new CuaStdio((executable, args, options) => {
    const child = spawn(executable, args, {
      ...options,
      env: { ...options.env, DISPLAY: `:${displays[mode]}` },
    });
    monitor.stdin.write(JSON.stringify({ pid: child.pid }) + "\n");
    return child;
  });
  let monitorClosed;
  let primary;
  try {
    monitor = spawn(
      "/usr/bin/python3",
      ["/opt/kaguya-tools/gui-interrupt-probe.py", mode],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    // close 在 spawn error 后也会发生；立即登记，不能在 finally 等可能永不发生的 exit。
    let spawnError;
    monitorClosed = new Promise((resolve) => {
      monitor.once("error", (error) => {
        spawnError = error;
      });
      monitor.once("close", (code) => resolve({ code, error: spawnError }));
    });
    let output = "",
      error = "",
      readyResolve,
      proxyResolve;
    const ready = new Promise((resolve) => {
      readyResolve = resolve;
    });
    const proxyReady = new Promise((resolve) => {
      proxyResolve = resolve;
    });
    monitor.stdout.on("data", (data) => {
      output += data;
      if (output.startsWith("proxy-ready\n")) proxyResolve();
      if (output.startsWith("proxy-ready\nready\n")) readyResolve();
    });
    monitor.stderr.on("data", (data) => {
      error += data;
    });
    monitor.stdin.on("error", (cause) => {
      error += cause.message;
    });
    const completed = monitorClosed.then((result) => {
      if (result.error || result.code !== 0)
        throw result.error ?? new Error(error || "monitor-failed");
    });
    completed.catch(() => {});
    await stage(
      () =>
        Promise.race([
          proxyReady,
          completed.then(() => {
            throw new Error("monitor-exited-before-ready");
          }),
        ]),
      15000,
      "proxy-start-timeout",
    );
    await stage(() => driver.start(), 60000, "driver-start-timeout");
    const call = (...args) =>
      stage(() => driver.call(...args), 30000, "driver-read-timeout");
    const windows = await call("list_windows", {});
    const target = windows.structuredContent?.windows.find(
      (w) =>
        w.title ===
        (mode === "held"
          ? "Kaguya keyboard acceptance"
          : "Kaguya isolated terminal"),
    );
    assert.ok(target, "terminal-must-remain-alive");
    const pid = target.pid,
      windowId = target.window_id ?? target.id;
    assert.ok(Number.isSafeInteger(pid) && Number.isSafeInteger(windowId));
    // 先通过一次明确的窗口点击确认输入焦点；以下被中断动作仍单独发送一次。
    const state = await call("get_window_state", {
      pid,
      window_id: windowId,
      max_image_dimension: 0,
    });
    const capture = state.structuredContent?.capture_id;
    assert.ok(
      capture,
      "terminal-capture-required:" +
        JSON.stringify({
          mode,
          state: {
            isError: state.isError,
            text: state.content
              ?.filter((item) => item.type === "text")
              .slice(0, 4)
              .map((item) => item.text?.slice(0, 2048)),
            screenshot_error: String(
              state.structuredContent?.screenshot_error ?? "",
            ).slice(0, 2048),
          },
          driverDiagnostics: driver.diagnostics.slice(-8192),
        }),
    );
    const clicked = await call(
      "click",
      {
        pid,
        window_id: windowId,
        x: 30,
        y: 30,
        capture_id: capture,
        delivery_mode: "foreground",
      },
      () => {},
    );
    assert.notEqual(clicked.isError, true);
    const before = await keyboard({ mode: "snapshot" });
    assert.deepEqual(before.keys, []);
    assert.deepEqual(before.buttons, []);
    const inputState =
      mode === "button"
        ? await call("get_window_state", {
            pid,
            window_id: windowId,
            max_image_dimension: 0,
          })
        : undefined;
    monitor.stdin.end(JSON.stringify({ arm: true }) + "\n");
    await stage(
      () =>
        Promise.race([
          ready,
          completed.then(() => {
            throw new Error("monitor-exited-before-armed");
          }),
        ]),
      15000,
      "proxy-arm-timeout",
    );
    // 只触发一次输入；预算不足时 gate 在 stdin.write 之前拒绝。
    const inputGate = stage.check;
    const request =
      mode === "button"
        ? driver.call(
            "click",
            {
              pid,
              window_id: windowId,
              x: 30,
              y: 30,
              capture_id: inputState.structuredContent.capture_id,
              delivery_mode: "foreground",
            },
            inputGate,
          )
        : mode === "held" || mode === "modifier"
          ? driver.call(
              "press_key",
              {
                pid,
                window_id: windowId,
                key: "a",
                modifiers: mode === "modifier" ? ["shift"] : [],
                delivery_mode: "foreground",
              },
              inputGate,
            )
          : driver.call(
              "type_text",
              {
                pid,
                window_id: windowId,
                text: "中".repeat(1000),
                delivery_mode: "foreground",
              },
              inputGate,
            );
    const settled = request.then(
      () => "returned",
      () => "interrupted",
    );
    await stage(() => completed, 25000, "monitor-completion-timeout");
    await stage(() => driver.stop(), 5000, "driver-stop-timeout");
    assert.equal(
      await stage(() => settled, 1000, "input-settle-timeout"),
      "interrupted",
    );
    const interruption = JSON.parse(output.split("\n")[2]);
    assert.equal(
      interruption.barrier,
      "forwarded-real-request-blocked-successors",
    );
    assert.ok(Object.keys(interruption.stoppedThreads).length > 0);
    assert.ok(
      Object.values(interruption.stoppedThreads).every(
        ([state]) => state === "T",
      ),
    );
    const residual = await keyboard({ mode: "snapshot" });
    await writeFile(
      `/home/tool/gui-drain-${mode}.json`,
      JSON.stringify({ mode, before, residual, interruption }),
    );
    if (mode === "held" || mode === "modifier")
      assert.ok(
        residual.keys.length > 0,
        "held-input-must-survive-driver-exit",
      );
    else if (mode === "button")
      assert.ok(
        residual.buttons.includes(1),
        "held-button-must-survive-driver-exit",
      );
    else
      assert.ok(
        residual.mapping.some((row) => row.includes(0x1004e2d)),
        "temporary-mapping-must-survive-driver-exit",
      );
    if (mode === "held")
      assert.ok(interruption.autoRepeat, "real-auto-repeat-required");
    if (mode === "modifier")
      assert.ok(
        residual.keys.some((key) =>
          residual.mapping[key - 8].some(
            (symbol) => symbol === 0xffe1 || symbol === 0xffe2,
          ),
        ),
        "held-shift-must-survive-driver-exit",
      );
    const reset = await keyboard({
      mode: "reset",
      before,
      expectedKeysyms: mode === "unicode" ? [0x1004e2d] : [],
    });
    assert.deepEqual(reset.keys, []);
    assert.deepEqual(reset.buttons, []);
    let applicationKeyRelease;
    if (mode === "held") {
      const deadline = Date.now() + 3000;
      while (true) {
        applicationKeyRelease = JSON.parse(
          await readFile("/run/kaguya-app/session/gui-key-events.json", "utf8"),
        );
        if (
          applicationKeyRelease.held.length === 0 &&
          applicationKeyRelease.releases > 0
        )
          break;
        if (Date.now() >= deadline)
          throw new Error("application-key-release-unconfirmed");
        await stage(() => delay(20), 1000, "application-release-wait-timeout");
      }
    }
    if (mode === "unicode") assert.ok(reset.restoredKeycodes.length > 0);
    const after = await keyboard({ mode: "snapshot" });
    assert.deepEqual(after.mapping, before.mapping);
    await stage(
      () => exec("/usr/bin/test", ["-d", `/proc/${pid}`], { timeout: 1000 }),
      2000,
      "application-identity-timeout",
    );
    console.log(
      JSON.stringify({
        mode,
        applicationPid: pid,
        interruptedKeys: interruption.observed.keys,
        interruptedButtons: interruption.observed.buttons,
        autoRepeat: interruption.autoRepeat,
        applicationKeyRelease,
        reset,
        mappingRestored: true,
      }),
    );
  } catch (error) {
    primary = error;
  } finally {
    const errors = primary ? [primary] : [];
    const cleanup = await Promise.allSettled([
      (async () => {
        if (monitor && monitor.exitCode === null && monitor.signalCode === null)
          monitor.kill("SIGKILL");
        await bounded(monitorClosed, 5000, "monitor-close-timeout");
      })(),
      bounded(driver.stop(), 10000, "driver-cleanup-timeout"),
      bounded(
        Promise.allSettled([...pendingHelpers]),
        10000,
        "x11-cleanup-timeout",
      ),
    ]);
    for (const result of cleanup)
      if (result.status === "rejected") errors.push(result.reason);
    if (errors.length)
      throw new AggregateError(errors, "gui-drain-probe-failed");
  }
}
