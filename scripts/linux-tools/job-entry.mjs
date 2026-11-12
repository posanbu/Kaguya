/**
 * 功能概述：独立 shell 容器内的启动门，不持有 permit、回执或控制 socket。
 * 主要职责：等待宿主 supervisor 核对截止与 cgroup 后发送 run，再执行绝对 argv。
 * 代码库关系：job_runner.py 经 Podman stdin 放行；容器 init 退出会清理整个 PID namespace。
 * 输入输出与副作用：启动门只用固定环境；用户 env 是 JSON 数据，仅在 run 后传给子进程。
 * stdout 首行是 ready 握手，之后为命令输出；cwd 受目录 FD 约束，命令退出即退出。
 */
import { spawn } from "node:child_process";
import { constants, openSync, closeSync } from "node:fs";
const [cwd, variables, command, ...args] = process.argv.slice(2);
let input = "";
process.stdout.write("kaguya-job-ready\n");
process.stdin.on("data", (data) => {
  input += data;
  if (input.length > 4) process.exit(125);
});
process.stdin.on("end", () => {
  if (input !== "run\n" || !command?.startsWith("/")) process.exit(125);
  let fd = openSync(
    "/workspace",
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    for (const part of cwd === "." ? [] : cwd.split("/")) {
      if (!part || [".", "..", ".kaguya-tools"].includes(part))
        process.exit(125);
      const next = openSync(
        `/proc/self/fd/${fd}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      closeSync(fd);
      fd = next;
    }
    process.chdir(`/proc/self/fd/${fd}`);
  } finally {
    closeSync(fd);
  }
  const child = spawn(command, args, {
    env: JSON.parse(variables),
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.on("error", () => process.exit(127));
  child.on("exit", (code) => process.exit(code ?? 128));
});
