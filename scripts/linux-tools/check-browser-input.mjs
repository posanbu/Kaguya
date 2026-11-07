/**
 * 功能概述：用显式屏障验证 browser 输入门的许可、旧准备动作和真实响应归属。
 * 代码库关系：消费生产 BrowserInputGate；真实 Chromium 的手势完成仍由容器专项验证。
 * 输入输出与副作用：无浏览器、无网络；不使用 sleep，不以调用方取消替代浏览器响应。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserInputGate } from "./browser-input.mjs";
const barrier = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

test("handoff waits for an actual browser response and permanently fences delayed preparation", async () => {
  const response = barrier();
  const gate = new BrowserInputGate({ now: () => 0 });
  const active = gate.permit(new Date(1000).toISOString());
  const delayed = gate.permit(new Date(1000).toISOString());
  let acknowledged = false,
    browserResponded = false;
  const sent = active.send(() =>
    response.promise.then((value) => {
      browserResponded = true;
      return value;
    }),
  );
  const isolation = gate.isolate().then(() => {
    assert.equal(
      browserResponded,
      true,
      "ACK preceded the real browser response",
    );
    acknowledged = true;
  });
  void isolation.catch(() => {});
  try {
    // 事件循环屏障让错误的空排空实现有机会发 ACK；不等待任何固定时长。
    await new Promise(setImmediate);
    assert.equal(acknowledged, false);
    assert.throws(
      () => delayed.send(() => assert.fail("old preparation sent input")),
      /fenced/,
    );
    response.resolve("browser-response");
    assert.equal(await sent, "browser-response");
    await isolation;
    assert.equal(acknowledged, true);
  } finally {
    response.resolve("cleanup");
    await Promise.allSettled([sent, isolation]);
  }
});

test("deadline is checked after preparation without relying on a timer callback", async () => {
  let now = 0;
  const gate = new BrowserInputGate({ now: () => now });
  const permit = gate.permit(new Date(1000).toISOString());
  now = 1000;
  assert.throws(
    () => permit.send(() => assert.fail("expired input")),
    /fenced/,
  );
  assert.equal(await gate.isolate(), true);
});

test("failed protocol response never yields an isolation ACK", async () => {
  const response = barrier();
  const gate = new BrowserInputGate({ now: () => 0 });
  const sent = gate
    .permit(new Date(1000).toISOString())
    .send(() => response.promise);
  const failure = assert.rejects(sent, /connection-lost/);
  const isolation = assert.rejects(gate.isolate(), /drain-unconfirmed/);
  response.reject(new Error("connection-lost"));
  await Promise.all([failure, isolation]);
});
