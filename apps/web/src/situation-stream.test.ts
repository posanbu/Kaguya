import { describe, expect, it } from "vitest";
import type { SituationView } from "@kaguya/schema";
import { situationStreams, situationTickWindow } from "./situation-stream.js";

function frame(
  id: string,
  sceneId: string,
  frozenAt: string,
): SituationView["frames"][number] {
  return {
    contractVersion: "1.0.0",
    id,
    agentId: "agent",
    frozenAt,
    background: { through: 1, evidence: [], continuation: false },
    current: { sceneId, evidence: [] },
    recalls: [],
    changes: {
      baseManifestId: null,
      evidenceIds: [],
      invalidatedEvidenceIds: [],
    },
  };
}
describe("rolling situation projection", () => {
  it("advances a stable scene head without rewriting an older frozen frame", () => {
    const old = frame("old", "scene:a", "2026-10-20T20:00:00Z");
    const latest = frame("new", "scene:a", "2026-10-20T20:01:00Z");
    const before = situationStreams([old])[0]!;
    const after = situationStreams([latest, old])[0]!;
    expect(after.sceneId).toBe(before.sceneId);
    expect(after.headFrameId).toBe("new");
    expect(after.revisions[1]).toBe(old);
    expect(before.headFrameId).toBe("old");
  });
  it("keeps registration order, separates scenes, and ignores repeated frame IDs", () => {
    const oldClock = frame("new", "scene:a", "2026-10-19T20:00:00Z");
    const old = frame("old", "scene:a", "2026-10-20T20:00:00Z");
    const other = frame("other", "scene:b", "2026-10-20T20:00:00Z");
    const streams = situationStreams([oldClock, other, old, oldClock]);
    expect(streams.map((s) => s.sceneId)).toEqual(["scene:a", "scene:b"]);
    expect(streams[0]!.revisions.map((f) => f.id)).toEqual(["new", "old"]);
    expect(streams[0]!.headFrameId).toBe("new");
  });
});

describe("tick action window", () => {
  const revisions = Array.from({ length: 8 }, (_, index) =>
    frame(`frame:${index}`, "scene:a", "2026-10-20T20:00:00Z"),
  );
  function step(
    id: string,
    frameId: string,
    sceneId = "scene:a",
  ): SituationView["steps"][number] {
    return {
      id,
      frameId,
      sceneId,
      at: "2026-10-20T20:00:00Z",
      tier: "light",
      phase: "completed",
      action: "silent",
      text: "",
      status: "silent",
      reasoning: null,
      nativeAvailable: false,
      receipt: null,
    };
  }
  it("shows only the selected tick and two adjacent ticks on each side", () => {
    const visible = situationTickWindow(revisions, revisions[3]!, [], 2);
    expect(visible.map((tick) => tick.offset)).toEqual([5, 4, 3, 2, 1]);
    expect(
      visible.filter((tick) => tick.selected).map((tick) => tick.frame.id),
    ).toEqual(["frame:3"]);
  });
  it("clamps the window at the scene head without inventing future ticks", () => {
    expect(
      situationTickWindow(revisions, revisions[0]!, [], 2).map(
        (tick) => tick.offset,
      ),
    ).toEqual([2, 1, 0]);
    expect(
      situationTickWindow(revisions, revisions[7]!, [], 1).map(
        (tick) => tick.offset,
      ),
    ).toEqual([7, 6]);
  });
  it("groups calls by both frozen frame and scene, in execution order", () => {
    const steps = [
      step("heavy", "frame:0"),
      step("light", "frame:0"),
      step("other-tick", "frame:5"),
      step("other-scene", "frame:0", "scene:b"),
      step("missing-frame", "absent"),
    ];
    const visible = situationTickWindow(revisions, revisions[0]!, steps, 1);
    expect(
      visible.flatMap((tick) => tick.steps.map((item) => item.id)),
    ).toEqual(["light", "heavy"]);
  });
  it("preserves a selected snapshot that has aged out of the polling window", () => {
    const pinned = frame("old", "scene:a", "2026-10-19T20:00:00Z");
    const visible = situationTickWindow(
      revisions,
      pinned,
      [step("old-action", "old")],
      2,
    );
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({
      frame: pinned,
      selected: true,
      offset: -1,
      steps: [{ id: "old-action" }],
    });
  });
});
