/**
 * 功能概述：为注意力评分的四个分项提供可点击的规则说明，解释已保存分数的含义。
 * 主要职责：ScoreRuleDialog 用工作台 Radix Dialog 提供标题、规则表、关闭与焦点恢复。
 * 代码库关系：规则对应 attention-arousal 的 scoreAttentionArousal/scoreContent/scorePressure/
 * scorePresencePenalty；由 GateSurface 的贡献图调用，不重新计算历史分数。
 * 输入输出与副作用：优先展示评估时持久化的命中步骤、输入参数与公式，通用规则按需展开；
 * 不把默认设置解释为历史配置，不从缺失字段推断命中细项，不调用 LLM 或修改运行状态。
 */
import { Info, X } from "lucide-react";
import type { JsonValue } from "@kaguya/schema";
import { Dialog } from "./components/ui.js";
import { readScoreEvidence } from "./score-evidence.js";

const rules = {
  relevance: {
    title: "相关性",
    description: "按直接性与持续关注状态打分，不使用 LLM 判断话题语义。",
    order: "从上往下匹配，命中第一项即采用该分数，不叠加。",
    rows: [
      ["@ 机器人", "100"],
      ["回复机器人，或文字包含机器人名称 / 别名", "80"],
      ["私聊或其他非群聊会话", "40"],
      ["群聊中的持续关注生效", "focusRelevance，默认 40"],
      ["其他群消息", "0"],
    ],
    notes: [
      "@ 按 mention ID 识别；回复按原消息发送者或机器人的成功投递记录识别；叫名采用忽略大小写的文本包含匹配。",
      "持续关注按会话延续，默认空闲期为 120 秒；成功投递续期，静默或失败关闭。它不检查后续消息是否延续同一话题。",
      "因此，提到名字不等于正在对机器人说话；没有叫名也可能在延续机器人的话题。这个分项无法区分这些语义。",
    ],
  },
  content: {
    title: "内容",
    description: "根据关键词、正则和清理后的文本长度评分，不做语义理解。",
    order: "不同类别可以叠加，同一类别在这一批输入中只计一次。",
    rows: [
      ["疑问特征", "+15"],
      ["请求特征", "+20"],
      ["征求意见", "+20"],
      ["合并文本至少 40 字符", "+5"],
      ["合并文本至少 120 字符", "再 +10"],
      ["空内容，或全部是指定短反应", "−25"],
    ],
    notes: [
      "例如“帮我”“能不能”会触发请求特征；“需要”“看看”等弱请求词，还要求输入直接指向机器人或来自私聊。",
      "长度达到 120 字符时，两档长度加分同时生效，共 +15；长度按 Unicode 字符计数。",
      "短反应扣分要求所有非空文本均不超过 8 字符，且都在预设短反应词表中。",
    ],
  },
  pressure: {
    title: "消息压力",
    description: "衡量积累的消息数量相对于当前发言频率是否足够，最高 100 分。",
    order:
      "设触发量 T = ceil(1 / f²)，消息比例 r = 消息数量 / T；f 为限制在 0–1 的有效频率。",
    rows: [
      ["消息比例 r ≤ 1", "round(50 × r²)，最高 50"],
      ["r ≤ 1 且达到平均空闲时间", "加 15，仍封顶 50"],
      ["1 < r < 5", "50 + round(50 × ln(r) / ln(5))"],
      ["r ≥ 5", "100"],
    ],
    notes: [
      "例如 f = 1 时触发量是 1；f = 0.1 时触发量是 100。频率越低，需要积累的消息越多。",
      "频率为 0 会被硬门禁拦截；此处即使记录了参考评分，也不会绕过门禁。",
    ],
  },
  recentPresencePenalty: {
    title: "近期在场惩罚",
    description:
      "机器人最近说话占比越高，越倾向让出交流空间。此项从总分中扣除。",
    order:
      "统计冻结时刻前 5 分钟、同一会话中的机器人成功投递数，占“收到的消息数 + 成功投递数”的比例。",
    rows: [
      ["占比 ≤ 25%，或投递数 / 总数为 0", "不扣分"],
      ["25% < 占比 < 60%", "round(25 × (占比 − 25%) / 35%)"],
      ["占比 ≥ 60%", "扣 25 分"],
    ],
    notes: [
      "中间区间随占比线性增加，四舍五入到整数；最高扣 25 分。",
      "贡献图把扣分画在零点左侧；0 表示这次没有扣分。",
    ],
  },
} as const;

export function ScoreRuleDialog({
  part,
  value,
  evidence,
}: {
  part: keyof typeof rules;
  value: number | undefined;
  evidence: JsonValue | undefined;
}) {
  const rule = rules[part];
  const recorded = readScoreEvidence(evidence, part, value);
  const cleanedText =
    recorded.state === "available" && part === "content"
      ? recorded.part.facts.find((fact) => fact.label === "清理后合并文本")
      : undefined;
  const points = (score: number) =>
    score === 0 ? "0" : `${score > 0 ? "+" : "−"}${Math.abs(score)}`;
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button
          className="gate-rule-trigger"
          type="button"
          aria-label={`查看${rule.title}评分规则`}
          title={`${rule.title}评分规则`}
        >
          <Info size={15} aria-hidden="true" />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="gate-rule-overlay" />
        <Dialog.Content className="gate-rule-dialog">
          <header>
            <Dialog.Title>{rule.title}如何计分</Dialog.Title>
            <Dialog.Close asChild>
              <button
                className="gate-rule-close"
                type="button"
                aria-label="关闭评分规则"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </Dialog.Close>
          </header>
          <Dialog.Description>{rule.description}</Dialog.Description>
          <p className="gate-rule-recorded">
            本次记录{" "}
            <strong>
              {value === undefined
                ? "未记录"
                : `${value === 0 ? "0" : `${value > 0 ? "+" : "−"}${Math.abs(value)}`} 分`}
            </strong>
          </p>
          {recorded.state === "available" ? (
            <section className="gate-rule-evidence" aria-label="本次计算依据">
              <h3>本次计算依据</h3>
              {cleanedText && (
                <blockquote>
                  <span>清理后的输入</span>
                  <p>{String(cleanedText.value) || "（空）"}</p>
                </blockquote>
              )}
              <ol>
                {recorded.part.steps.map((step, index) => (
                  <li key={index}>
                    <span>{step.label}</span>
                    <strong>{points(step.delta)}</strong>
                  </li>
                ))}
              </ol>
              {recorded.part.formula && (
                <p className="gate-rule-formula">{recorded.part.formula}</p>
              )}
              <details className="gate-rule-facts">
                <summary>输入与参数</summary>
                <dl>
                  {recorded.part.facts.map((fact, index) => (
                    <div key={index}>
                      <dt>{fact.label}</dt>
                      <dd>
                        {typeof fact.value === "boolean"
                          ? fact.value
                            ? "是"
                            : "否"
                          : fact.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </details>
            </section>
          ) : (
            <p className="gate-rule-missing">
              {recorded.state === "missing"
                ? "这条历史记录没有保存该分项的计算依据。"
                : recorded.state === "inconsistent"
                  ? "计算依据与已记录分数不一致，暂不展示具体命中过程。"
                  : "这条记录的计算依据格式暂不支持。"}
            </p>
          )}
          <details
            className="gate-rule-reference"
            open={recorded.state !== "available"}
          >
            <summary>查看完整评分规则</summary>
            <p className="gate-rule-order">{rule.order}</p>
            <table>
              <thead>
                <tr>
                  <th scope="col">匹配条件</th>
                  <th scope="col">分数规则</th>
                </tr>
              </thead>
              <tbody>
                {rule.rows.map(([condition, score]) => (
                  <tr key={condition}>
                    <th scope="row">{condition}</th>
                    <td>{score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul>
              {rule.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
            <footer>
              以上为当前代码规则；本次计算依据取自评估时保存的记录。
            </footer>
          </details>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
