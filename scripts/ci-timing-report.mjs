import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const seconds = (start, end) => {
  const value = (Date.parse(end) - Date.parse(start)) / 1000;
  return Number.isFinite(value) && value >= 0 ? value : null;
};
export function summarize(run, jobs) {
  const executed = jobs.filter((job) => job.conclusion !== "skipped");
  const complete =
    jobs.length > 0 &&
    executed.every((job) => seconds(job.started_at, job.completed_at) !== null);
  const end =
    complete && executed.length
      ? new Date(
          Math.max(...executed.map((job) => Date.parse(job.completed_at))),
        ).toISOString()
      : null;
  const start =
    complete && executed.length
      ? new Date(
          Math.min(...executed.map((job) => Date.parse(job.started_at))),
        ).toISOString()
      : null;
  return {
    id: run.id,
    url: run.html_url,
    event: run.event,
    sha: run.head_sha,
    attempt: run.run_attempt,
    conclusion: run.conclusion,
    createdAt: run.created_at,
    // On reruns, creation-to-finish includes the manual wait before the rerun.
    elapsedSeconds: end ? seconds(run.created_at, end) : null,
    executionSpanSeconds: end && start ? seconds(start, end) : null,
    initialWaitSeconds: start ? seconds(run.created_at, start) : null,
    runnerMinutes: complete
      ? executed.reduce(
          (sum, job) => sum + (seconds(job.started_at, job.completed_at) ?? 0),
          0,
        ) / 60
      : null,
    jobs: jobs.map((job) => ({
      name: job.name,
      conclusion: job.conclusion,
      seconds:
        job.conclusion === "skipped"
          ? null
          : seconds(job.started_at, job.completed_at),
      steps: (job.steps ?? []).map((step) => ({
        name: step.name,
        conclusion: step.conclusion,
        seconds: seconds(step.started_at, step.completed_at),
      })),
    })),
  };
}
export async function collect(request, repo, triggerId) {
  async function runs(event) {
    const result = await request(
      `/repos/${repo}/actions/workflows/test.yml/runs?event=${event}&status=completed&per_page=10`,
    );
    return result.workflow_runs;
  }
  const workflow = await request(`/repos/${repo}/actions/workflows/test.yml`);
  const trigger = await request(`/repos/${repo}/actions/runs/${triggerId}`);
  if (trigger.workflow_id !== workflow.id || trigger.status !== "completed") {
    throw new Error("Target must be a completed Test workflow run");
  }
  const selected = new Map(
    [
      ...(await runs("pull_request")),
      ...(await runs("schedule")),
      ...(await runs("workflow_dispatch")),
      trigger,
    ].map((run) => [run.id, run]),
  );
  const reports = [];
  for (const run of selected.values()) {
    const jobs = [];
    for (let page = 1; ; page++) {
      const result = await request(
        `/repos/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`,
      );
      jobs.push(...result.jobs);
      if (result.jobs.length < 100) break;
    }
    const report = summarize(run, jobs);
    report.artifactInventory = await inventoryArtifacts(request, repo, run);
    reports.push(report);
  }
  return reports.sort((a, b) => b.id - a.id);
}
// Metadata only: never download or execute artifacts from a PR in this workflow.
export async function inventoryArtifacts(request, repo, run) {
  const items = [];
  try {
    for (let page = 1; ; page++) {
      const result = await request(
        `/repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100&page=${page}`,
      );
      if (!Array.isArray(result.artifacts))
        throw new Error("Invalid artifact list");
      for (const item of result.artifacts) {
        const attempt = /-attempt-(\d+)$/.exec(item.name);
        items.push({
          id: item.id,
          name: item.name,
          expired: item.expired,
          sizeBytes: item.size_in_bytes,
          createdAt: item.created_at,
          expiresAt: item.expires_at,
          attempt: attempt ? Number(attempt[1]) : null,
        });
      }
      if (result.artifacts.length < 100) break;
    }
    return { status: "available", items };
  } catch {
    // Missing permissions or a failed page must not look like zero artifacts.
    return { status: "unknown", items: [] };
  }
}
const display = (value) => (value === null ? "未知" : value.toFixed(1));
export function markdown(reports) {
  const prs = reports.filter(
    (run) =>
      run.event === "pull_request" &&
      run.attempt === 1 &&
      run.conclusion !== "cancelled",
  );
  const over = prs.filter(
    (run) => run.elapsedSeconds !== null && run.elapsedSeconds > 180,
  );
  const unknown = prs.filter((run) => run.elapsedSeconds === null);
  const daily = reports.filter((run) => run.event === "schedule");
  const lines = [
    "# CI 耗时观测",
    "",
    "范围仅含 Test 工作流；创建时间指工作流运行创建时间，不是 PR 创建时间。NapCat、Linux tools 和其他独立检查未计入，不能据此判断全部 PR 检查是否在三分钟内完成。",
    "",
    `PR 首次尝试非取消样本 ${prs.length} 次，其中创建至完成超过 180 秒 ${over.length} 次，耗时未知 ${unknown.length} 次。`,
    `每日全量样本 ${daily.length} 次，通过 ${daily.filter((run) => run.conclusion === "success").length} 次。`,
    "",
    "创建至首次作业启动包含调度等待；作业跨度包含依赖等待。runner 分钟为作业时长之和，非账单分钟。重跑仅统计最新 attempt，不能据此推定 flaky；重跑的创建至完成还包含人工等待。",
    "",
    "| 运行 | 事件 / attempt | 结果 | 创建至完成 s | 首次启动等待 s | 作业跨度 s | runner min | 超过 180s 的作业 |",
    "|---|---|---|---:|---:|---:|---:|---|",
  ];
  for (const run of reports)
    lines.push(
      `| [${run.id}](${run.url}) | ${run.event} / ${run.attempt} | ${run.conclusion} | ${display(run.elapsedSeconds)} | ${display(run.initialWaitSeconds)} | ${display(run.executionSpanSeconds)} | ${display(run.runnerMinutes)} | ${
        run.jobs
          .filter((job) => job.seconds > 180)
          .map((job) => job.name.replaceAll("|", "\\|"))
          .join(", ") ||
        (run.jobs.length === 0 ||
        run.jobs.some(
          (job) => job.conclusion !== "skipped" && job.seconds === null,
        )
          ? "部分作业耗时未知"
          : "无")
      } |`,
    );
  lines.push("", "## 作业与步骤", "");
  for (const run of reports) {
    lines.push(`### ${run.id}`, "");
    lines.push(
      `提交：\`${run.sha ?? "未知"}\`；运行创建：${run.createdAt ?? "未知"}。`,
      "",
    );
    const inventory = run.artifactInventory;
    if (inventory?.status === "available") {
      const current = inventory.items.filter(
        (item) => item.attempt === run.attempt,
      );
      lines.push(
        `当前 attempt 命名的产物 ${current.length} 个，可用 ${current.filter((item) => item.expired === false).length} 个；未标 attempt 的产物 ${inventory.items.filter((item) => item.attempt === null).length} 个。元数据不证明测试数量或报告内容完整。`,
        "",
      );
      for (const item of inventory.items)
        lines.push(
          `- 产物 ${item.id}: ${item.name.replaceAll(/[\r\n|`]/g, " ")}, attempt ${item.attempt ?? "未知"}, ${item.expired === true ? "已过期" : item.expired === false ? "可下载" : "状态未知"}, ${item.sizeBytes ?? "未知"} bytes`,
        );
      lines.push("");
    } else lines.push("产物清单未知（未采集或读取失败），不能推断未生成。", "");
    for (const job of run.jobs) {
      lines.push(`- ${job.name}: ${job.conclusion}, ${display(job.seconds)}s`);
      for (const step of job.steps)
        lines.push(
          `  - ${step.name}: ${step.conclusion}, ${display(step.seconds)}s`,
        );
    }
  }
  return lines.join("\n") + "\n";
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.TARGET_RUN_ID;
  if (!repo || !runId || !process.env.GITHUB_TOKEN)
    throw new Error("Repository, target run and token are required");
  const request = async (route) => {
    const response = await fetch(`https://api.github.com${route}`, {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok)
      throw new Error(`GitHub API ${response.status} for ${route}`);
    return response.json();
  };
  const reports = await collect(request, repo, runId);
  const output = process.env.CI_REPORT_DIR ?? "ci-report";
  await mkdir(output, { recursive: true });
  await writeFile(`${output}/runs.json`, JSON.stringify(reports, null, 2));
  const summary = markdown(reports);
  await writeFile(`${output}/summary.md`, summary);
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
}
