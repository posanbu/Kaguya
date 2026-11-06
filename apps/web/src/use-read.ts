import { useCallback, useEffect, useState } from "react";

type ReadState<T> = {
  data?: T;
  error: boolean;
  loading: boolean;
  token?: string;
};

export function useRead<T>(token: string, load: (token: string) => Promise<T>) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<ReadState<T>>({
    error: false,
    loading: true,
  });
  useEffect(() => {
    let live = true;
    setState((previous) => ({
      ...(previous.token === token ? previous : {}),
      token,
      error: false,
      loading: true,
    }));
    void load(token).then(
      (data) => {
        if (live) setState({ token, data, error: false, loading: false });
      },
      () => {
        if (live) setState({ token, error: true, loading: false });
      },
    );
    return () => {
      live = false;
    };
  }, [token, load, revision]);
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  return {
    ...(state.token === token ? state : { error: false, loading: true }),
    retry,
  };
}
