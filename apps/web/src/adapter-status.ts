/** Public adapter status DTO and visibility-bound polling; no configuration secrets. */
export interface AdapterStatus {
  adapterHostState: string;
  runtime: { ingress: string; reason?: string };
  adapters: {
    adapterId: string;
    type: string;
    platform: string;
    enabled: boolean;
    lifecycle: string;
    connectivity: string;
    ingress: string;
    updatedAt: string;
    attempt?: number;
    nextRetryAt?: string;
    errorType?: string;
  }[];
}
export interface StatusPollState {
  snapshot?: AdapterStatus;
  updatedAt?: string;
  failed: boolean;
  loading: boolean;
}
export function pollAdapterStatus(options: {
  load: (signal: AbortSignal) => Promise<AdapterStatus>;
  visibility: Pick<
    Document,
    "hidden" | "addEventListener" | "removeEventListener"
  >;
  onChange: (state: StatusPollState) => void;
}) {
  let state: StatusPollState = { failed: false, loading: false };
  let controller: AbortController | undefined;
  let sequence = 0;
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const cancel = () => {
    sequence++;
    controller?.abort();
    controller = undefined;
  };
  const refresh = async () => {
    if (disposed || options.visibility.hidden) return;
    cancel();
    const current = sequence;
    controller = new AbortController();
    state = { ...state, loading: true };
    options.onChange(state);
    try {
      const snapshot = await options.load(controller.signal);
      if (disposed || current !== sequence) return;
      state = {
        snapshot,
        updatedAt: new Date().toISOString(),
        failed: false,
        loading: false,
      };
    } catch {
      if (disposed || current !== sequence) return;
      state = { ...state, failed: true, loading: false };
    }
    controller = undefined;
    options.onChange(state);
  };
  const visibilityChanged = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    cancel();
    if (!options.visibility.hidden && !disposed) {
      void refresh();
      timer = setInterval(() => {
        if (!controller) void refresh();
      }, 2000);
    }
  };
  options.visibility.addEventListener("visibilitychange", visibilityChanged);
  visibilityChanged();
  return {
    refresh,
    stop: () => {
      disposed = true;
      cancel();
      if (timer !== undefined) clearInterval(timer);
      options.visibility.removeEventListener(
        "visibilitychange",
        visibilityChanged,
      );
    },
  };
}
