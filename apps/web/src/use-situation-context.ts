import { useEffect, useRef, useState } from "react";
import { inspectionDetailSchema } from "@kaguya/schema";
import { getInspection } from "./api.js";
import {
  situationRequestContext,
  type SituationRequestContext,
} from "./situation-context.js";

/** Requests are immutable. Fetch a selected request once, with a bounded in-memory cache. */
export function useSituationContext(
  token: string,
  requestId: string | undefined,
) {
  const cache = useRef({
    token,
    entries: new Map<string, SituationRequestContext>(),
  });
  const [state, setState] = useState<{
    key: string;
    data?: SituationRequestContext;
    error?: string;
  }>({ key: "" });
  const key = `${token}:${requestId ?? ""}`;
  useEffect(() => {
    if (cache.current.token !== token)
      cache.current = { token, entries: new Map() };
    if (!requestId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        let data = cache.current.entries.get(requestId);
        if (!data) {
          const detail = await getInspection(
            { token },
            `atoms/${encodeURIComponent(requestId)}`,
            inspectionDetailSchema,
            controller.signal,
          );
          data = situationRequestContext(detail.atom.payload) ?? undefined;
          if (!data) throw new Error("这条请求没有可读取的上下文");
        }
        if (controller.signal.aborted) return;
        cache.current.entries.set(requestId, data);
        if (cache.current.entries.size > 80)
          cache.current.entries.delete(
            cache.current.entries.keys().next().value!,
          );
        setState({ key, data });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({
          key,
          error: error instanceof Error ? error.message : "读取上下文失败",
        });
        timer = setTimeout(() => void read(), 30_000);
      }
    };
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [token, requestId, key]);
  return state.key === key ? state : { key };
}
