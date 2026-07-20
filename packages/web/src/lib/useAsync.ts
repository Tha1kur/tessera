import { useCallback, useEffect, useState } from "react";

import { ApiError } from "./api";

/**
 * Load data for a page.
 *
 * Three things that are easy to get wrong and are handled once here:
 *
 *   - The request is aborted when the component unmounts or the inputs change,
 *     so navigating away mid-request does not set state on a dead component
 *     and does not leave a slow earlier response overwriting a newer one.
 *   - `loading` starts true, so a page never flashes "nothing here" before its
 *     first response arrives.
 *   - Errors are captured rather than thrown, because a failed fetch should
 *     render a message, not blank the screen.
 */
export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useAsync<T>(loader: (signal: AbortSignal) => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    loader(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setData(result);
      })
      .catch((cause: unknown) => {
        // An abort is the expected result of navigating away, not a failure.
        if (controller.signal.aborted || (cause as Error)?.name === "AbortError") return;
        setError(cause instanceof ApiError ? cause.message : "Something went wrong. Please try again.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, loading, error, reload };
}
