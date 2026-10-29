/**
 * 功能概述：为模块集成测试按取得资源的逆序清理，避免启动或关闭异常泄漏宿主与数据库。
 * closeTestResources 取出栈中所有回调，逐一 await；失败仍继续清理，最后以 AggregateError 保留全部错误。
 * 代码库关系：Heartbeat、Lifecycle、Router fixture 在资源取得后立即登记，afterEach 调用本函数。
 * 输入输出与副作用：接收可变回调栈并清空；不并行关闭有依赖关系的 host/core/database，不吞掉失败。
 */
export async function closeTestResources(
  stack: Array<() => Promise<unknown>>,
): Promise<void> {
  const failures: unknown[] = [];
  for (const close of stack.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "Test resource cleanup failed");
}
