/**
 * 功能概述：为 Promptfoo 暴露回复节奏案例的离线生产编译预览。
 * 主要职责：ReplyRhythmProvider 按 caseId 选取已验证案例，返回 Light/Heavy 请求及来源哈希。
 * 代码库关系：reply-rhythm.yaml 使用本 Provider；具体装配复用 benchmarks/reply-rhythm/assemble.cjs。
 * 输入输出与副作用：不调用模型、不读取 profile、不写账本；结构通过不表示模型节奏通过。
 */
const { assemble } = require("../benchmarks/reply-rhythm/assemble.cjs");
const cases = require("../benchmarks/reply-rhythm/cases.json");
class ReplyRhythmProvider {
  constructor(options = {}) {
    this.providerId = options.id || "kaguya-reply-rhythm-preview";
  }
  id() {
    return this.providerId;
  }
  async callApi(_prompt, context) {
    const item = cases.find((entry) => entry.id === context?.vars?.caseId);
    if (!item) throw new Error("unknown reply rhythm case");
    const preview = await assemble(item);
    return {
      output: JSON.stringify(preview),
      metadata: { stage: "assembly-preview", networkRequests: 0 },
    };
  }
}
module.exports = ReplyRhythmProvider;
