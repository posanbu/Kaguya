/**
 * 功能概述：首阶段真实 Cua discovery/跨 UID 观察探针，保存固定二进制的协议证据。
 * 主要职责：启动同一生产 stdio 适配器，读取窗口和原始桌面截图；不连接任何模型。
 * 代码库关系：check-gui-container.py 启动 GTK fixture 后调用；后续动作验收共用此通道。
 * 输入输出与副作用：证据写入可信 HOME，stdout 只含摘要；finally 等待 Driver 进程组消失。
 */
import { mkdir, writeFile, stat, rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { CuaStdio } from "./cua-stdio.mjs";
await mkdir("/home/tool/runtime", { mode: 0o700, recursive: true });
const driver = new CuaStdio();
const evidence = {};
async function observed(read, predicate, label) {
  const deadline = Date.now() + 15000;
  while (true) {
    const result = await read();
    assert.notEqual(result.isError, true, `${label}:tool-error`);
    if (predicate(result)) return result;
    if (Date.now() >= deadline)
      throw new Error(
        `${label}:condition-timeout:${text(result).slice(0, 2000)}`,
      );
    await delay(20);
  }
}
const text = (result) =>
  result.content
    ?.filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n") ?? "";
const element = (result, name) => {
  const rows = text(result);
  const snapshot = /snapshot_id=([^\s]+)/.exec(rows)?.[1];
  const row = rows
    .split("\n")
    .find((line) => /\[\d+\]/.test(line) && line.includes('"' + name + '"'));
  const index = /\[(\d+)\]/.exec(row ?? "")?.[1];
  assert.ok(snapshot && index, "fixture-element-token-missing");
  return `${snapshot}:${index}`;
};
try {
  const wish = spawnSync("wish", [], { env: { PATH: "/opt/cua/helpers" } });
  assert.equal(
    wish.error?.code,
    "ENOENT",
    "trusted-driver-must-not-resolve-wish",
  );
  evidence.wishExcluded = true;
  const discovery = (evidence.discovery = await driver.start());
  await writeFile(
    "/home/tool/gui-probe-driver.pending",
    JSON.stringify(driver.identity()),
  );
  await rename(
    "/home/tool/gui-probe-driver.pending",
    "/home/tool/gui-probe-driver.json",
  );
  const admissionDeadline = Date.now() + 30000;
  while (true) {
    try {
      await stat("/home/tool/gui-probe-continue");
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (Date.now() >= admissionDeadline)
      throw new Error("isolation-probe-not-completed");
    await delay(20);
  }
  const windows = (evidence.windows = await observed(
    () => driver.call("list_windows", {}),
    (result) => text(result).includes("Kaguya GUI acceptance"),
    "gtk-window-published",
  ));
  assert.notEqual(windows.isError, true);
  assert.match(JSON.stringify(windows), /Kaguya GUI acceptance/);
  const pid = Number(process.argv[2]);
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  const windowId = windows.structuredContent?.windows.find(
    (candidate) =>
      candidate.pid === pid && candidate.title === "Kaguya GUI acceptance",
  )?.window_id;
  assert.ok(Number.isSafeInteger(windowId) && windowId > 0);
  const window = (evidence.window = await observed(
    () =>
      driver.call("get_window_state", {
        pid,
        window_id: windowId,
        max_image_dimension: 0,
      }),
    (result) =>
      text(result).includes("Unsaved text") &&
      text(result).includes("Increment once"),
    "gtk-accessibility-published",
  ));
  assert.notEqual(window.isError, true);
  assert.match(text(window), /Unsaved text/);
  assert.match(text(window), /Increment once/);
  const desktop = (evidence.desktop = await driver.call("get_desktop_state", {
    max_image_dimension: 0,
  }));
  assert.notEqual(desktop.isError, true);
  for (const result of [window, desktop]) {
    const image = result.content?.find((c) => c.type === "image");
    assert.equal(image?.mimeType, "image/png");
    const bytes = Buffer.from(image.data, "base64");
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.ok(bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(16) <= 1280);
    assert.ok(bytes.readUInt32BE(20) > 0 && bytes.readUInt32BE(20) <= 800);
  }
  const buttonState = await driver.call("get_window_state", {
    pid,
    window_id: windowId,
  });
  const click = (evidence.click = await driver.call(
    "click",
    {
      pid,
      window_id: windowId,
      element_token: element(buttonState, "Increment once"),
    },
    () => assert.equal(process.getuid(), 1000),
  ));
  assert.notEqual(click.isError, true);
  const entryState = await driver.call("get_window_state", {
    pid,
    window_id: windowId,
  });
  const typed = (evidence.typed = await driver.call(
    "type_text",
    {
      pid,
      window_id: windowId,
      element_token: element(entryState, "Unsaved text"),
      text: "W8 ASCII",
      delivery_mode: "foreground",
    },
    () => assert.equal(process.getuid(), 1000),
  ));
  assert.notEqual(typed.isError, true);
  const asciiState = await observed(
    () => driver.call("get_window_state", { pid, window_id: windowId }),
    (result) => text(result).includes("W8 ASCII"),
    "gtk-ascii-inserted",
  );
  // 固定 Cua 0.38 InsertText 的长度处理会截断 UTF-8；Unicode 使用明确的整字段赋值。
  evidence.filled = await driver.call(
    "set_value",
    {
      pid,
      window_id: windowId,
      element_token: element(asciiState, "Unsaved text"),
      value: "W8 暂存",
    },
    () => assert.equal(process.getuid(), 1000),
  );
  assert.notEqual(evidence.filled.isError, true);
  evidence.after = await observed(
    () =>
      driver.call("get_window_state", {
        pid,
        window_id: windowId,
        max_image_dimension: 0,
      }),
    (result) => text(result).includes("W8 暂存"),
    "gtk-text-delivered",
  );
  assert.match(text(evidence.after), /W8 暂存/);
  for (const [name, result] of [
    ["gui-gtk.png", evidence.after],
    ["gui-desktop.png", desktop],
  ]) {
    const picture = result.content?.find((c) => c.type === "image");
    assert.equal(picture?.mimeType, "image/png");
    await writeFile(`/home/tool/${name}`, Buffer.from(picture.data, "base64"));
  }
  console.log(
    JSON.stringify({
      driver: driver.identity(),
      tools: discovery.discovered.tools.length,
      windowText: text(evidence.after),
      desktopText: text(desktop),
      screenshots: ["gui-gtk.png", "gui-desktop.png"],
    }),
  );
} catch (error) {
  console.error(driver.diagnostics);
  throw error;
} finally {
  try {
    await writeFile(
      "/home/tool/gui-probe.json",
      JSON.stringify(evidence, null, 2),
    );
  } finally {
    await driver.stop();
  }
}
