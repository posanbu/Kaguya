/**
 * 功能概述：验证 Focus 的真实调度落账与重启恢复，以及纯投影代际和参与终态边界。
 * 真实 PGlite/Core 测试确认 schedule 键与到期终态；参与测试隔离模型和投递 I/O，仅喂入已完成回合事实。
 * 旧代际到期不可撤销新 grant，失败不续租；所有资源在 finally 释放。
 */
import { describe, it, expect, vi } from "vitest";
import {
  oneShotRequestedInformationKind,
  oneShotDueInformationKind,
  oneShotScheduleCapability,
} from "@kaguya/scheduler";
import { attentionFocusModule } from "./index.js";
import {
  focusOpened,
  focusRenewed,
  focusClosed,
  focusExpired,
  activeFocus,
} from "./facts.js";
import { cognitiveFixture } from "../test-support/cognitive-fixture.js";
import { atom } from "../message-composer/test-fixtures.js";
import {
  turnContextCompletedInformationKind,
  turnCompletedInformationKind,
  turnFailedInformationKind,
} from "../information-kinds.js";
const grantPayload = {
  scopeKey: "one",
  generation: "source",
  startedAt: "2026-09-09T00:00:00.000Z",
  expiresAt: "2026-09-09T00:02:00.000Z",
  reason: "named-self",
  sourceInformationId: "source",
};
it("persists one expiry arm, restores it after restart and commits an expiry terminal", async () => {
  const f = await cognitiveFixture([attentionFocusModule]);
  try {
    const source = await f.context();
    const grant = await f.core.registerOnce(
      "test.focus",
      "source",
      focusOpened,
      {
        occurredAt: "2026-09-09T00:00:10.000Z",
        source: "module:test",
        payload: { ...grantPayload, sourceInformationId: source.informationId },
        references: [
          { relation: "core:caused-by", informationId: source.informationId },
          { relation: "core:context", informationId: source.informationId },
          {
            relation: "core:uses-context",
            informationId: source.informationId,
          },
        ],
      },
    );
    await vi.waitFor(
      async () =>
        expect(await f.all(oneShotRequestedInformationKind.kind)).toHaveLength(
          1,
        ),
      { timeout: 5000 },
    );
    await f.restart();
    const schedule = (await f.all(oneShotRequestedInformationKind.kind))[0]!;
    expect(
      (await f.database.information.oneShotSchedules.listOpen({ limit: 10 }))
        .arms,
    ).toHaveLength(1);
    f.setNow("2026-09-09T00:02:00.000Z");
    await f.core.register(oneShotDueInformationKind, {
      occurredAt: "2026-09-09T00:02:00.000Z",
      source: "core:test",
      payload: {
        scheduleInformationId: schedule.informationId,
        dueAt: grantPayload.expiresAt,
        deliveredAt: grantPayload.expiresAt,
      },
      references: [
        { relation: "core:status-of", informationId: schedule.informationId },
      ],
    });
    await vi.waitFor(
      async () => expect(await f.all(focusExpired.kind)).toHaveLength(1),
      { timeout: 5000 },
    );
    expect(
      (await f.all(focusExpired.kind))[0]!.references.some(
        (r) => r.informationId === grant.informationId,
      ),
    ).toBe(true);
    await vi.waitFor(
      async () =>
        expect(
          (
            await f.database.information.oneShotSchedules.listOpen({
              limit: 10,
            })
          ).arms,
        ).toHaveLength(0),
      { timeout: 5000 },
    );
    expect(await f.all(oneShotRequestedInformationKind.kind)).toHaveLength(1);
  } finally {
    await f.close();
  }
});
describe("focus generation and participation", () => {
  it("does not revive an older lease or let its expiry cancel a newer lease", () => {
    const old = atom("old", focusOpened.kind, grantPayload);
    const next = atom("new", focusRenewed.kind, {
      ...grantPayload,
      generation: "next",
      startedAt: "2026-09-09T00:00:30.000Z",
      expiresAt: "2026-09-09T00:02:30.000Z",
    });
    const expired = atom(
      "expired",
      focusExpired.kind,
      { scopeKey: "one", reason: "idle", generation: "source" },
      [{ relation: "core:status-of", informationId: "old" }],
    );
    expect(
      activeFocus([old, next, expired], "one", "2026-09-09T00:01:00.000Z")
        ?.informationId,
    ).toBe("new");
    expect(
      activeFocus([old, next], "two", "2026-09-09T00:01:00.000Z"),
    ).toBeUndefined();
    const closed = atom(
      "closed",
      focusClosed.kind,
      { scopeKey: "one", reason: "silent", generation: "next" },
      [{ relation: "core:status-of", informationId: "new" }],
    );
    expect(
      activeFocus([old, next, closed], "one", "2026-09-09T00:01:00.000Z"),
    ).toBeUndefined();
  });
  it.each([true, false])(
    "renews only successful participation (success=%s)",
    async (success) => {
      const grant = atom("grant", focusOpened.kind, grantPayload);
      const turn = atom("turn", turnContextCompletedInformationKind.kind, {
        focusInformationId: "grant",
        isPrivate: false,
      });
      const registerOnce = vi.fn(async (..._args: unknown[]) => grant);
      const commitTerminal = vi.fn(async () => grant);
      const scheduler = {
        schedule: vi.fn(),
        finish: vi.fn(),
        replace: vi.fn(),
      };
      const lifecycle = {
        signal: new AbortController().signal,
        now: () => new Date(),
        report: async () => {},
        use: () => scheduler as never,
      };
      const instance = await attentionFocusModule.create(
        {
          instanceId: "focus.test",
          activation: {
            instanceId: "focus.test",
            definitionId: attentionFocusModule.manifest.definitionId,
          },
          settings: {},
        },
        lifecycle,
      );
      const kind = success
        ? turnCompletedInformationKind
        : turnFailedInformationKind;
      const terminal = atom("terminal", kind.kind, {
        scopeKey: "one",
        claimInformationId: "claim",
      });
      await instance.subscriptions
        .find((s) => s.subscriptionId === `focus.participation.${kind.kind}`)!
        .handle(terminal, {
          ...lifecycle,
          sourceAtom: terminal,
          instanceId: "focus.test",
          definitionId: attentionFocusModule.manifest.definitionId,
          select: async () => [grant, turn],
          registerOnce,
          commitTerminal,
        } as never);
      if (success) {
        expect(registerOnce).toHaveBeenCalledOnce();
        expect(registerOnce.mock.calls[0]![2]).toBe(focusRenewed);
        expect(commitTerminal).not.toHaveBeenCalled();
      } else {
        expect(registerOnce).not.toHaveBeenCalled();
        expect(commitTerminal).toHaveBeenCalledOnce();
      }
    },
  );
});
