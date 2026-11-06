import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const seconds = (start, end) => {
  const value = (Date.parse(end) - Date.parse(start)) / 1000;
  return Number.isFinite(value) && value >= 0 ? value : null;
};
export function summarize(run, jobs) {
  const executed = jobs.filter(
    (job) => job.started_at && job.completed_at && job.conclusion !== "skipped",
  );
  const end = executed
    .map((job) => job.completed_at)
    .sort()
    .at(-1);
  const start = executed.map((job) => job.started_at).sort()[0];
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
    runnerMinutes:
      executed.reduce(
        (sum, job) => sum + (seconds(job.started_at, job.completed_at) ?? 0),
        0,
      ) / 60,
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
  const trigger = await request(`/repos/${repo}/actions/runs/${triggerId}`);
  const selected = new Map(
    [
      trigger,
      ...(await runs("pull_request")),
      ...(await runs("schedule")),
      ...(await runs("workflow_dispatch")),
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
    reports.push(summarize(run, jobs));
  }
  return reports.sort((a, b) => b.id - a.id);
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
  const daily = reports.filter((run) => run.event === "schedule");
  const lines = [
    "# CI 耗时观测",
    "",
    `PR 首次尝试非取消样本 ${prs.length} 次，其中创建至完成超过 180 秒 ${over.length} 次。`,
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
          .join(", ") || "无"
      } |`,
    );
  lines.push("", "## 作业与步骤", "");
  for (const run of reports) {
    lines.push(`### ${run.id}`, "");
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
