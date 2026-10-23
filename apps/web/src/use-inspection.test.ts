import { describe, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({
  state: undefined as unknown,
  effect: undefined as (() => (() => void) | undefined) | undefined,
}));
vi.mock("react", () => ({
  useState: (initial: unknown) => [
    hooks.state ?? initial,
    (value: unknown) => {
      hooks.state = value;
    },
  ],
  useEffect: (effect: typeof hooks.effect) => {
    hooks.effect = effect;
  },
}));
vi.mock("./api.js", () => ({ getInspection: vi.fn() }));
import { getInspection } from "./api.js";
import { useInspection } from "./use-inspection.js";
const schema = { parse: (value: unknown) => value };
describe("inspection refresh", () => {
  it("retains the same query while refreshing but isolates credentials and queries", async () => {
    hooks.state = undefined;
    vi.mocked(getInspection).mockResolvedValue({ modules: ["running"] });
    useInspection("token", "modules", schema, 0);
    const cleanup = hooks.effect?.();
    await Promise.resolve();
    cleanup?.();
    expect(useInspection("token", "modules", schema, 1).data).toEqual({
      modules: ["running"],
    });
    expect(useInspection("other", "modules", schema, 1).data).toBeUndefined();
    expect(useInspection("token", "atoms", schema, 1).data).toBeUndefined();
  });
  it("ignores responses after cleanup", async () => {
    hooks.state = undefined;
    let resolve!: (value: unknown) => void;
    vi.mocked(getInspection).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    useInspection("token", "modules", schema, 0);
    const cleanup = hooks.effect?.();
    cleanup?.();
    resolve({ modules: ["old"] });
    await Promise.resolve();
    expect(useInspection("token", "modules", schema, 1).data).toBeUndefined();
  });
});
