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
