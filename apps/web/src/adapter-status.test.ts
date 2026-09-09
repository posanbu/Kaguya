import { afterEach, expect, it, vi } from "vitest";
import {
  pollAdapterStatus,
  type AdapterStatus,
  type StatusPollState,
} from "./adapter-status.js";
afterEach(() => vi.useRealTimers());
const snapshot: AdapterStatus = {
  adapterHostState: "running",
  runtime: { ingress: "runtime_unavailable", reason: "database_unavailable" },
  adapters: [],
};
function visibility() {
  const events = new EventTarget();
  return Object.assign(events, { hidden: false });
}
it("polls every two seconds, pauses when hidden, refreshes on return and disposes", async () => {
  vi.useFakeTimers();
  const page = visibility();
  const load = vi.fn(async () => snapshot);
  const onChange = vi.fn();
  const poller = pollAdapterStatus({ load, visibility: page, onChange });
  await vi.advanceTimersByTimeAsync(0);
  expect(load).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1999);
  expect(load).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(load).toHaveBeenCalledTimes(2);
  page.hidden = true;
  page.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(6000);
  expect(load).toHaveBeenCalledTimes(2);
  page.hidden = false;
  page.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(load).toHaveBeenCalledTimes(3);
  await poller.refresh();
  expect(load).toHaveBeenCalledTimes(4);
  poller.stop();
  await vi.advanceTimersByTimeAsync(4000);
  expect(load).toHaveBeenCalledTimes(4);
});
it("retains the last snapshot on failure and ignores cancelled stale responses", async () => {
  vi.useFakeTimers();
  const page = visibility();
  let state: StatusPollState | undefined;
  let resolveOld: (value: AdapterStatus) => void = () => {};
  const load = vi
    .fn<(signal: AbortSignal) => Promise<AdapterStatus>>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValueOnce(snapshot)
    .mockRejectedValueOnce(new Error("offline"));
  const poller = pollAdapterStatus({
    load,
    visibility: page,
    onChange: (value) => {
      state = value;
    },
  });
  const signal = load.mock.calls[0]![0];
  await poller.refresh();
  expect(signal.aborted).toBe(true);
  resolveOld({ ...snapshot, adapterHostState: "stopped" });
  await vi.advanceTimersByTimeAsync(0);
  expect(state?.snapshot).toBe(snapshot);
  await poller.refresh();
  expect(state).toMatchObject({ snapshot, failed: true, loading: false });
  poller.stop();
});
it("aborts pending requests on hide and unmount without publishing errors", async () => {
  vi.useFakeTimers();
  const page = visibility();
  const load = vi.fn<(signal: AbortSignal) => Promise<AdapterStatus>>(
    () => new Promise(() => {}),
  );
  const onChange = vi.fn();
  const poller = pollAdapterStatus({ load, visibility: page, onChange });
  page.hidden = true;
  page.dispatchEvent(new Event("visibilitychange"));
  expect(load.mock.calls[0]![0].aborted).toBe(true);
  page.hidden = false;
  page.dispatchEvent(new Event("visibilitychange"));
  poller.stop();
  expect(load.mock.calls[1]![0].aborted).toBe(true);
  expect(onChange.mock.calls.every(([state]) => state.failed === false)).toBe(
    true,
  );
});

it("represents initial failure without manufacturing a snapshot", async () => {
  vi.useFakeTimers();
  const onChange = vi.fn();
  const poller = pollAdapterStatus({
    load: async () => {
      throw new Error("offline");
    },
    visibility: visibility(),
    onChange,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(onChange.mock.lastCall?.[0]).toEqual({ failed: true, loading: false });
  poller.stop();
});
