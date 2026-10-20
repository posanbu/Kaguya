import { useEffect, useState } from "react";
import { situationViewSchema, type SituationView } from "@kaguya/schema";
import { getInspection } from "./api.js";

/** Serial polling preserves the last successful view, scroll containers and expanded rows. */
export function useSituation(token: string): {
  data?: SituationView;
  error?: string;
  refreshedAt?: string;
} {
  const [state, setState] = useState<{
    token: string;
    data?: SituationView;
    error?: string;
    refreshedAt?: string;
  }>({ token });
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const data = await getInspection(
          { token },
          "situation",
          situationViewSchema,
          controller.signal,
        );
        if (!controller.signal.aborted)
          setState({ token, data, refreshedAt: new Date().toISOString() });
      } catch (error) {
        if (!controller.signal.aborted)
          setState((old) => ({
            token,
            ...(old.token === token
              ? { data: old.data, refreshedAt: old.refreshedAt }
              : {}),
            error: error instanceof Error ? error.message : "读取失败",
          }));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 3000);
      }
    };
    const poll = () => {
      if (document.visibilityState === "hidden") timer = setTimeout(poll, 3000);
      else void read();
    };
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [token]);
  return state.token === token ? state : {};
}
