/**
 * 功能概述：汇总 Runtime 的最终信息原子 API，导出 kind、LLM lifecycle 与
 * `KaguyaRuntime` ingress。
 * 主要职责：稳定 re-export，不创建数据库、Core、模块或 transport；事件 dispatch、
 * workflow 和旧 service locator 已从公共面删除。
 * 代码库关系：apps/server 与 demo 从包入口消费 Runtime；Runtime 实现并消费
 * platform-adapters 定义的 `InformationIngress`/transport 契约。本 barrel 依次重导出
 * allowlist、kind、lifecycle 与组合 Runtime，所有入站数据都通过 `InformationIngress.submit`，
 * 无需事件桥接或重复 definition。
 * 输入输出与副作用：仅静态导出符号，无运行时 I/O；所有 kind definition 保持其原始对象身份。
 */
export * from "./gateway-allowlist.js";
export * from "./information-kinds.js";
export * from "./llm-lifecycle.js";
export * from "./runtime.js";
