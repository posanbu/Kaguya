import { describe, expect, it } from "vitest";
import { adapterStatusValues } from "./AdapterStatusPanel.js";
import type { AdapterStatus } from "./adapter-status.js";

const adapter: AdapterStatus["adapters"][number] = {
  adapterId: "napcat.qq.main",
  type: "napcat",
  platform: "qq",
  enabled: true,
  lifecycle: "running",
  connectivity: "connected",
  ingress: "ready",
  updatedAt: "2026-09-20T00:00:00.000Z",
  attempt: 1,
};

describe("Adapter 紧凑状态值", () => {
  it("只返回可直接阅读的状态，不重复类别标签", () => {
    expect(adapterStatusValues(adapter).map((value) => value.label)).toEqual([
      "已启用",
      "运行中",
      "已连接",
      "可提交消息",
    ]);
  });

  it("保留失败原因并标记为错误", () => {
    expect(
      adapterStatusValues({
        ...adapter,
        lifecycle: "failed",
        connectivity: "disconnected",
        errorType: "connection_failed",
      }),
    ).toEqual(
      expect.arrayContaining([
        { label: "失败", tone: "error" },
        { label: "已断开", tone: "error" },
        { label: "连接失败", tone: "error" },
      ]),
    );
  });
});
