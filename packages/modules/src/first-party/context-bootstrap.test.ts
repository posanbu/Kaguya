/**
 * 功能概述：验证冷启动状态来自冻结且可见的证据，而非身份建档、人设或全库推断。
 * 主要职责：通过真实 Planner/Composer 编译器覆盖空上下文、历史与记忆渐进补全、陌生参与者、
 * 裁剪和冻结截止边界；模板覆盖用例确认角色化措辞仍由声明的 default/local 契约控制。
 * 代码库关系：复用消息 fixture、Node 默认模板与 contextBootstrapVariable，不调用外部模型。
 * 输入输出与副作用：仅内存原子与纯函数断言，无数据库、时钟等待或网络副作用。
 */
import { describe, expect, it } from "vitest";
import { loadFirstPartyPromptTemplates } from "../node/prompt-templates.js";
import { contextBootstrapVariable } from "./context-bootstrap.js";
import { compilePlannerPrompt } from "./heartflow/planner.js";
import { compileMessagePrompt } from "./message-composer/message-prompt.js";
import {
  atom,
  fixture,
  identity,
  target,
} from "./message-composer/test-fixtures.js";
import { type CompiledPrompt } from "@kaguya/schema";

const templates = loadFirstPartyPromptTemplates();
const state = (prompt: CompiledPrompt) =>
  JSON.parse(
    prompt.variables.find((v) => v.name === "context_bootstrap")!.content,
  );
function prior(id: string, senderId: string, groupId = "group-1") {
  return atom(id, "core.message.inbound.text", {
    text: "我喜欢音乐，这是我的自述",
    source: {
      ...target,
      destination: { kind: "group", groupId },
      senderId,
      platformMessageId: `platform-${id}`,
    },
  });
}

describe("context bootstrap", () => {
  it("keeps complete identity and rich fictional persona distinct from actual familiarity", () => {
    const f = fixture();
    const persona = { ...identity, persona: "我曾在月亮与所有群友一起唱歌" };
    const planner = compilePlannerPrompt(
      persona,
      f.atoms,
      f.turn,
      templates.planner,
    );
    const composer = compileMessagePrompt(
      templates.messageComposer,
      persona,
      f.atoms,
      f.intent.informationId,
    );
    for (const prompt of [planner, composer]) {
      expect(state(prompt)).toMatchObject({
        mode: "bootstrap",
        historyCount: 0,
        memoryCount: 0,
      });
      expect(state(prompt).participants).toEqual([
        {
          inputIndex: 0,
          identityStatus: "complete",
          scopeMode: "ephemeral",
          priorInboundCount: 0,
        },
        {
          inputIndex: 1,
          identityStatus: "complete",
          scopeMode: "ephemeral",
          priorInboundCount: 0,
        },
      ]);
      expect(
        prompt.variables.find((v) => v.name === "context_bootstrap")!
          .informationIds,
      ).toEqual([f.turn.informationId]);
      expect(prompt.text).toContain("坦率");
      expect(prompt.text).toContain("角色");
    }
  });

  it("moves to contextual with sourced memory and history without treating every participant as familiar", () => {
    const f = fixture();
    const history = prior("previous", "sender-0");
    const memory = atom("memory", "memory.text", {
      text: "群友自述喜欢音乐",
    });
    const turn = atom(f.turn.informationId, f.turn.kind, {
      ...f.turn.payload,
      memory: [memory.informationId],
    });
    const intent = atom(
      f.intent.informationId,
      f.intent.kind,
      { ...f.intent.payload, memoryInformationIds: [memory.informationId] },
      [...f.intent.references],
    );
    const atoms = [intent, turn, ...f.messages, history, memory];
    for (const prompt of [
      compilePlannerPrompt(identity, atoms, turn, templates.planner),
      compileMessagePrompt(
        templates.messageComposer,
        identity,
        atoms,
        intent.informationId,
      ),
    ]) {
      expect(state(prompt)).toMatchObject({
        mode: "contextual",
        historyCount: 1,
        memoryCount: 1,
      });
      expect(
        state(prompt).participants.map(
          (p: { priorInboundCount: number }) => p.priorInboundCount,
        ),
      ).toEqual([1, 0]);
      expect(
        prompt.variables.find((v) => v.name === "context_bootstrap")!
          .informationIds,
      ).toEqual([
        turn.informationId,
        history.informationId,
        memory.informationId,
      ]);
    }
  });

  it("does not promote foreign, future or current messages into prior acquaintance", () => {
    const f = fixture();
    const foreign = prior("foreign", "sender-0", "other-group");
    const future = {
      ...prior("future", "sender-0"),
      occurredAt: "2026-09-10T00:00:00.000Z",
    };
    const projected = contextBootstrapVariable(
      f.turn,
      [...f.messages, foreign, future],
      [],
    );
    expect(JSON.parse(projected.content)).toMatchObject({
      mode: "bootstrap",
      historyCount: 0,
    });
    expect(projected.informationIds).toEqual([f.turn.informationId]);
  });

  it("does not count an assistant claim as prior inbound evidence from a person", () => {
    const f = fixture();
    const assistant = atom("assistant", "core.message.assistant.text", {
      text: "我们是老朋友",
      source: target,
    });
    const projected = JSON.parse(
      contextBootstrapVariable(f.turn, [assistant], []).content,
    );
    expect(projected.historyCount).toBe(1);
    expect(
      projected.participants.every(
        (p: { priorInboundCount: number }) => p.priorInboundCount === 0,
      ),
    ).toBe(true);
  });

  it("counts only memory visible after Composer's character budget", () => {
    const f = fixture();
    const memories = [
      atom("long-memory", "memory.text", {
        text: "有来源的长记忆".repeat(5000),
      }),
      atom("hidden-memory", "memory.text", { text: "不应计入可见证据" }),
    ];
    const intent = atom(
      f.intent.informationId,
      f.intent.kind,
      {
        ...f.intent.payload,
        memoryInformationIds: memories.map((m) => m.informationId),
      },
      [...f.intent.references],
    );
    const prompt = compileMessagePrompt(
      templates.messageComposer,
      identity,
      [intent, f.turn, ...f.messages, ...memories],
      intent.informationId,
    );
    expect(state(prompt).memoryCount).toBe(1);
    expect(
      prompt.variables.find((v) => v.name === "context_bootstrap")!
        .informationIds,
    ).not.toContain("hidden-memory");
    expect(prompt.text).not.toContain("不应计入可见证据");
  });

  it("supports custom bootstrap phrasing without changing the projected facts", () => {
    const f = fixture();
    const prompt = compileMessagePrompt(
      {
        ...templates.messageComposer,
        main: "辉夜先听你介绍：{{context_bootstrap}}",
      },
      identity,
      f.atoms,
      f.intent.informationId,
    );
    expect(prompt.text).toBe(
      `辉夜先听你介绍：${prompt.variables.find((v) => v.name === "context_bootstrap")!.content}`,
    );
    expect(state(prompt).mode).toBe("bootstrap");
  });
});
