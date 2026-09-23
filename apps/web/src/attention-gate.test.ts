import { describe, expect, it } from "vitest";
import {
  gateContextStatus,
  gateDecision,
  type GateField,
} from "./attention-gate.js";

const fields = (payload: Record<string, unknown>) =>
  Object.entries(payload).map(
    ([path, value]) => ({ path, label: path, value }) as GateField,
  );

describe("attention observation presentation", () => {
  it("explains direct, Focus, periodic, awake and asleep branches", () => {
    expect(
      gateDecision(
        fields({ outcome: "observe", reasonCodes: ["mention-self"] }),
      ),
    ).toMatchObject({ branch: "direct", label: "查看未读" });
    expect(
      gateDecision(
        fields({ outcome: "observe", reasonCodes: ["focus-active"] }),
      ),
    ).toMatchObject({ branch: "focus" });
    expect(
      gateDecision(
        fields({ outcome: "observe", reasonCodes: ["periodic-recheck"] }),
      ),
    ).toMatchObject({ branch: "recheck" });
    expect(
      gateDecision(
        fields({
          outcome: "observe",
          reasonCodes: ["arousal-awake"],
        }),
      ),
    ).toMatchObject({ branch: "awake", label: "查看未读" });
    expect(
      gateDecision(
        fields({ outcome: "defer", reasonCodes: ["arousal-asleep"] }),
      ),
    ).toMatchObject({ branch: "asleep", label: "延后观察" });
  });

  it("does not infer missing Focus state", () => {
    expect(gateContextStatus(fields({}))).toMatchObject({
      tone: "warning",
      label: "Focus 状态缺失",
    });
    expect(gateContextStatus(fields({ focusState: "active" }))).toMatchObject({
      tone: "success",
      label: "Focus 有效",
    });
  });

  it("keeps unknown facts explicit", () => {
    expect(
      gateDecision(fields({ outcome: "observe", reasonCodes: ["future"] })),
    ).toMatchObject({
      branch: "unknown",
      reasons: ["future"],
    });
  });
});
