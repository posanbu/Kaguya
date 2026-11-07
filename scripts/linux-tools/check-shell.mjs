/** 功能概述：可信桌面入口的隔离屏障测试；任意 shell 实测由 check-container.py 覆盖。
 * 主要职责：显式 Promise barrier 验证 ACK 等待组件排空、失败不推进代次、重复控制不重做。
 * 代码库关系：直接调用生产 ToolService；不执行外部命令或模拟容器隔离已成功。
 * 输入输出与副作用：仅内存状态，所有阻塞在 finally 释放；不依赖固定 sleep。 */
import test from "node:test";
import assert from "node:assert/strict";
import { ToolService } from "./service.mjs";
const request = {
  helperProtocolVersion: 1,
  kind: "control",
  action: "handoff",
  environmentId: "env",
  expectedGeneration: 0,
  generation: 1,
  mode: "human",
  controlOperationId: "control",
};
test(
  "handoff waits for actual component drain and replays one ACK",
  { timeout: 5000 },
  async () => {
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    let count = 0;
    const service = new ToolService({
      environmentId: "env",
      generation: 0,
      components: [
        {
          async isolate() {
            count++;
            entered.resolve();
            return release.promise;
          },
        },
      ],
    });
    const pending = service.handle(request);
    try {
      await entered.promise;
      assert.equal(service.mode, "draining");
      assert.equal(service.generation, 0);
      release.resolve(true);
      const ack = await pending;
      assert.equal(ack.automationIsolated, true);
      assert.deepEqual(await service.handle(request), ack);
      assert.equal(count, 1);
    } finally {
      release.resolve(true);
      await pending;
    }
  },
);
test(
  "failed component never acknowledges isolation",
  { timeout: 5000 },
  async () => {
    const service = new ToolService({
      environmentId: "env",
      generation: 0,
      components: [
        {
          async isolate() {
            return false;
          },
        },
      ],
    });
    await assert.rejects(
      service.handle(request),
      /automation-isolation-unconfirmed/,
    );
    assert.equal(service.generation, 0);
    assert.equal(service.mode, "draining");
  },
);
test(
  "trusted desktop helper does not execute shell requests",
  { timeout: 5000 },
  async () => {
    const service = new ToolService({ environmentId: "env", generation: 0 });
    await assert.rejects(
      service.handle({
        helperProtocolVersion: 1,
        kind: "operation",
        toolName: "shell.exec",
      }),
      /tool-not-supported/,
    );
  },
);
