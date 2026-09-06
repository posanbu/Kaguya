/**
 * 功能概述：把有序 Prompt fragment 编译为转义文本与可审计 provenance。
 * 主要职责：按 priority 和原位置稳定排序、检查 prompt scope、转义标签内容、计算
 * SHA-256 摘要，并把动态 fragment 的 informationId 条件复制到 provenance。
 * 代码库关系：消费 `@kaguya/schema` 的 Prompt 契约；modules 负责从账本原子生成动态
 * fragment，Runtime 与 LLM lifecycle 持久化这里的编译结果。
 * 输入输出与副作用：纯内存、确定性编译，不访问账本或网络；静态 fragment 可不含
 * informationId，动态 fragment 的原子追溯由调用方提供。
 */
import { createHash } from "node:crypto";

import type { CompiledPrompt, PromptFragment } from "@kaguya/schema";

type PromptKind = CompiledPrompt["kind"];

export class PromptCompiler {
  compile(
    kind: PromptKind,
    fragments: readonly PromptFragment[],
  ): CompiledPrompt {
    for (const fragment of fragments) {
      const scope = fragment.metadata.scope;
      if (typeof scope === "string" && scope !== kind) {
        throw new Error(`fragment is not valid for ${kind} prompt`);
      }
    }

    const sortedFragments = fragments
      .map((fragment, position) => ({ fragment, position }))
      .sort(
        (left, right) =>
          left.fragment.priority - right.fragment.priority ||
          left.position - right.position,
      )
      .map(({ fragment }) => fragment);

    return {
      kind,
      text: sortedFragments.map(renderFragment).join("\n\n"),
      fragments: sortedFragments,
      provenance: sortedFragments.map((fragment) => ({
        fragmentId: fragment.id,
        ...(fragment.informationId === undefined
          ? {}
          : { informationId: fragment.informationId }),
        source: fragment.source,
        priority: fragment.priority,
        contentDigest: createHash("sha256")
          .update(fragment.content)
          .digest("hex"),
      })),
    };
  }
}

function renderFragment(fragment: PromptFragment): string {
  const sourceId = escapeAttribute(fragment.id);
  const content = escapeBody(fragment.content);
  return `<${fragment.source} source="${sourceId}">\n${content}\n</${fragment.source}>`;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeBody(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
