#!/usr/bin/env node
/**
 * 功能概述：提供 reply-rhythm 的离线预览、复核模板和确定性报告入口。
 * 主要职责：main 读取显式 JSON 文件；preview 编译全部案例，review 建立绑定候选的待复核记录，
 * score 核对复核并分别报告漏答、额外行动、待复核和传输失败；baseline 运行内置合成标注。
 * 输出采用独占写入防止覆盖。
 * 代码库关系：protocol.cjs 执行输入和人工复核契约；assemble.cjs 延迟加载生产源码编译器。
 * 输入输出与副作用：只读给定案例/候选/复核文件，输出 0600 文件；不读取凭据，不联网或发送消息。
 * 使用 node bench.cjs preview CASES OUTPUT，review CASES CANDIDATES OUTPUT，score CASES CANDIDATES REVIEWS OUTPUT。
 */
const fs = require("node:fs");
const path = require("node:path");
const { validateCase, reviewTemplate, score } = require("./protocol.cjs");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
async function main(args) {
  let [command, ...files] = args;
  if (command === "baseline") {
    if (files.length !== 1) throw new Error("usage: baseline OUTPUT");
    command = "score";
    files = ["cases.json", "baseline-candidates.json", "baseline-reviews.json"]
      .map((name) => path.join(__dirname, name))
      .concat(files);
  }
  const required = { preview: 2, review: 3, score: 4 }[command];
  if (!required || files.length !== required)
    throw new Error(
      "usage: baseline OUTPUT | preview CASES OUTPUT | review CASES CANDIDATES OUTPUT | score CASES CANDIDATES REVIEWS OUTPUT",
    );
  const cases = read(files[0]);
  cases.forEach(validateCase);
  let result;
  if (command === "preview") {
    const { assemble } = require("./assemble.cjs");
    result = [];
    for (const item of cases) result.push(await assemble(item));
  } else {
    const candidates = read(files[1]);
    // 先校验候选身份、状态及完整案例集，错误和超时也保留在评分分母。
    score(cases, candidates, []);
    result =
      command === "score"
        ? score(cases, candidates, read(files[2]))
        : candidates
            .filter((candidate) => candidate.status === "ok")
            .map((candidate) =>
              reviewTemplate(
                cases.find((item) => item.id === candidate.caseId),
                candidate,
              ),
            );
  }
  fs.writeFileSync(files.at(-1), `${JSON.stringify(result, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}
if (require.main === module)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { main };
