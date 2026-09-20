/**
 * 功能概述：只为已声明为 editable 的模块模板显式创建受 Git 忽略的 local 副本。
 * 主要职责：调用统一资源存储的 initializeLocalPromptTemplates，输出新建与保留的数量；已有文件绝不覆盖。
 * 代码库关系：由根目录 pnpm prompt:init 执行，与生产加载器及模板管理端共享资源白名单和整组校验。
 * 输入输出与副作用：复制 default 正文到缺失的 local；不修改默认模板、不连接服务、不输出 Prompt 内容。
 */
import { initializeLocalPromptTemplates } from "../packages/modules/src/node/prompt-template-store.js";

const result = initializeLocalPromptTemplates();
console.log(
  `Prompt 本地副本初始化完成：新建 ${result.created.length}，保留 ${result.preserved.length}。`,
);
