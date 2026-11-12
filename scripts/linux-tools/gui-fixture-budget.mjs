/**
 * 功能概述：GUI drain fixture 的绝对总预算与独立清理等待，不改变生产 RPC deadline。
 * 主要职责：fixtureBudget 在每阶段启动前扣除已耗时间，bounded 为单次 Promise 提供明确上限。
 * 代码库关系：gui-drain-probe 四模式共享 150 秒，清理另留 10 秒，外层 Podman 180 秒保留调度余量。
 * 输入输出与副作用：预算耗尽不启动后续动作，不重试输入；计时器在成功/失败后均回收。
 */
export async function bounded(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function fixtureBudget(
  milliseconds,
  { now = () => performance.now(), bound = bounded } = {},
) {
  const deadline = now() + milliseconds;
  const check = () => {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error("gui-drain-total-deadline");
    return remaining;
  };
  const stage = (start, cap, message) => {
    const remaining = check();
    return Promise.resolve(
      bound(start(), Math.min(cap, remaining), message),
    ).then((value) => {
      check();
      return value;
    });
  };
  stage.check = check;
  return stage;
}
