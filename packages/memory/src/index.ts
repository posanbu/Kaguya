/**
 * 功能概述：统一导出 Memory 原始文档、向量投影与外部认知契约。
 * contracts 定义无 I/O 的基础 schema；vector/cognition 单向依赖 contracts，避免入口循环初始化。
 * 本入口不建立连接或注册任务，供 database、modules 与 composition 引用版本化 capability。
 */
export * from "./contracts.js";
export * from "./vector.js";
export * from "./cognition.js";
