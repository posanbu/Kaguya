/**
 * 功能概述：验证评分证据只在能对应历史分项时展示，不从规则补造缺失过程。
 * 主要职责：覆盖已保存步骤、旧记录、未来版本、重复分项和分数不一致的边界。
 * 代码库关系：测试 score-evidence 的只读解析，不调用模型或数据库。
 */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@kaguya/schema";
import { readScoreEvidence } from "./score-evidence.js";

const part = {
  id: "content",
  value: -25,
  facts: [{ label: "清理后文本", value: "嗯" }],
  steps: [{ label: "全部为指定短反应", delta: -25 }],
  formula: "0 − 25 = −25",
};
const evidence: JsonObject = { version: 1, parts: [part] };
describe("历史评分证据", () => {
  it("展示已经保存的实际命中步骤与输入", () => {
    expect(readScoreEvidence(evidence, "content", -25)).toEqual({
      state: "available",
      part,
    });
  });
  it("旧记录和缺失分项不从当前规则生成说明", () => {
    expect(readScoreEvidence(undefined, "content", -25)).toEqual({
      state: "missing",
    });
    expect(readScoreEvidence(evidence, "relevance", 100)).toEqual({
      state: "missing",
    });
  });
  it("未知版本和不合法事实不可解释为本次命中", () => {
    expect(
      readScoreEvidence({ ...evidence, version: 2 }, "content", -25),
    ).toEqual({ state: "unsupported" });
    expect(
      readScoreEvidence(
        {
          version: 1,
          parts: [{ ...part, facts: [{ label: "输入", value: null }] }],
        },
        "content",
        -25,
      ),
    ).toEqual({ state: "unsupported" });
  });
  it("不展示与保存分数或步骤之和不一致的证据", () => {
    expect(readScoreEvidence(evidence, "content", 0)).toEqual({
      state: "inconsistent",
    });
    expect(readScoreEvidence(evidence, "content", undefined)).toEqual({
      state: "inconsistent",
    });
    expect(
      readScoreEvidence(
        {
          version: 1,
          parts: [{ ...part, steps: [{ label: "未扣分", delta: 0 }] }],
        },
        "content",
        -25,
      ),
    ).toEqual({ state: "inconsistent" });
  });
  it("重复分项不能静默取第一条", () => {
    expect(
      readScoreEvidence({ version: 1, parts: [part, part] }, "content", -25),
    ).toEqual({ state: "inconsistent" });
  });
});
