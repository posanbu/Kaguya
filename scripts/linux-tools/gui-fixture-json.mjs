/**
 * 功能概述：原子发布合成 GUI 应用的 JSON 回执，不承担生产数据持久化。
 * 主要职责：publishFixtureJson 先完整写入同目录临时文件，再 rename 到公开路径；失败保留旧回执。
 * 代码库关系：Chromium fixture 发布 ready/ledger，check-gui.mjs 用发布屏障验证并发读取边界。
 * 输入输出与副作用：同一路径由 fixture 的串行队列写入；读者只看到缺失、旧值或完整新值。
 */
import { promises as fs } from "node:fs";

export async function publishFixtureJson(path, value) {
  const pending = `${path}.pending`;
  await fs.writeFile(pending, JSON.stringify(value), { mode: 0o600 });
  await fs.rename(pending, path);
}
