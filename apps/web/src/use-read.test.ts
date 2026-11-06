import { beforeEach, describe, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  effect: undefined as (() => () => void) | undefined,
}));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = initial;
    return [
      hooks.slots[index],
      (value: unknown) => {
        hooks.slots[index] =
          typeof value === "function" ? value(hooks.slots[index]) : value;
      },
    ];
  },
  useEffect: (effect: typeof hooks.effect) => {
    hooks.effect = effect;
  },
  useCallback: (callback: unknown) => callback,
}));
import { useRead } from "./use-read.js";
function render(token: string, load: (token: string) => Promise<string>) {
  hooks.cursor = 0;
  return useRead(token, load);
}
beforeEach(() => {
  hooks.slots = [];
  hooks.cursor = 0;
});
describe("overview reads", () => {
  it("retains loaded data during refresh and replaces it when the response arrives", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce("running")
      .mockResolvedValueOnce("stopped");
    render("test", load);
    hooks.effect?.();
    await Promise.resolve();
    render("test", load).retry();
    render("test", load);
    hooks.effect?.();
    expect(render("test", load)).toMatchObject({
      data: "running",
      loading: true,
    });
    await Promise.resolve();
    expect(render("test", load)).toMatchObject({
      data: "stopped",
      loading: false,
    });
  });
  it("does not expose another token's data and ignores disposed requests", async () => {
    const load = vi.fn().mockResolvedValue("running");
    render("test", load);
    hooks.effect?.();
    await Promise.resolve();
    expect(render("other", load).data).toBeUndefined();
    const dispose = hooks.effect?.();
    dispose?.();
    await Promise.resolve();
    expect(render("other", load).data).toBeUndefined();
  });
  it("reports refresh failures without claiming old data is current", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce("running")
      .mockRejectedValueOnce(new Error("offline"));
    render("test", load);
    hooks.effect?.();
    await Promise.resolve();
    render("test", load).retry();
    render("test", load);
    hooks.effect?.();
    await Promise.resolve();
    expect(render("test", load)).toMatchObject({ error: true, loading: false });
    expect(render("test", load).data).toBeUndefined();
  });
});
