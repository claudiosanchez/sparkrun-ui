"use client";

import { useCallback, useEffect, useState } from "react";
import { rpc } from "@/lib/rpc/client";
import type { TokenHistoryResult, TrendRange } from "@/lib/tokenHistory";
import {
  isFreshHistoryCache,
  tokenHistoryCacheKey,
  TOKEN_HISTORY_REFRESH_MS,
} from "./tokenHistoryData";

const historyCache = new Map<string, { result: TokenHistoryResult; fetchedAtMs: number }>();
const inFlightHistory = new Map<string, Promise<TokenHistoryResult>>();

export type TokenHistoryQueryState = {
  requestedRange: TrendRange;
  displayedRange: TrendRange | null;
  result: TokenHistoryResult | null;
  isInitialLoading: boolean;
  isRefreshing: boolean;
  isStale: boolean;
  error: string | null;
  retry: () => void;
};

function initialState(cluster: string, range: TrendRange): Omit<TokenHistoryQueryState, "retry"> {
  const cached = historyCache.get(tokenHistoryCacheKey(cluster, range));
  const fresh = cached !== undefined && isFreshHistoryCache(cached.fetchedAtMs, Date.now());

  return {
    requestedRange: range,
    displayedRange: cached?.result.range ?? null,
    result: cached?.result ?? null,
    isInitialLoading: cached === undefined,
    isRefreshing: cached !== undefined && !fresh,
    isStale: cached !== undefined && !fresh,
    error: null,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "Unable to load token history.";
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

export function useTokenHistory(cluster: string, range: TrendRange): TokenHistoryQueryState {
  const [state, setState] = useState(() => initialState(cluster, range));
  const [retryNonce, setRetryNonce] = useState(0);
  const cacheKey = tokenHistoryCacheKey(cluster, range);

  useEffect(() => {
    const ac = new AbortController();
    const { signal } = ac;
    let requestPromise: Promise<TokenHistoryResult> | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;

    const cached = historyCache.get(cacheKey);
    const fresh = cached !== undefined && isFreshHistoryCache(cached.fetchedAtMs, Date.now());

    if (cached !== undefined) {
      setState((previous) => ({
        ...previous,
        requestedRange: range,
        displayedRange: range,
        result: cached.result,
        isInitialLoading: false,
        isRefreshing: !fresh,
        isStale: !fresh,
        error: null,
      }));
    } else {
      setState((previous) => ({
        ...previous,
        requestedRange: range,
        isInitialLoading: previous.result === null,
        isRefreshing: previous.result !== null,
        isStale: false,
        error: null,
      }));
    }

    async function load(): Promise<void> {
      if (signal.aborted) return;

      try {
        const existing = inFlightHistory.get(cacheKey);
        if (existing !== undefined) {
          requestPromise = existing;
        } else {
          requestPromise = rpc.tokenHistory.get({ cluster, range }, { signal });
          inFlightHistory.set(cacheKey, requestPromise);
          const ownedRequest = requestPromise;
          void ownedRequest.then(
            () => {
              if (inFlightHistory.get(cacheKey) === ownedRequest) inFlightHistory.delete(cacheKey);
            },
            () => {
              if (inFlightHistory.get(cacheKey) === ownedRequest) inFlightHistory.delete(cacheKey);
            },
          );
        }

        setState((previous) => ({
          ...previous,
          requestedRange: range,
          isInitialLoading: previous.result === null,
          isRefreshing: previous.result !== null,
          error: null,
        }));

        const next = await requestPromise;
        if (signal.aborted) return;
        historyCache.set(cacheKey, { result: next, fetchedAtMs: Date.now() });
        setState((previous) => ({
          ...previous,
          requestedRange: range,
          displayedRange: range,
          result: next,
          isInitialLoading: false,
          isRefreshing: false,
          isStale: false,
          error: null,
        }));
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return;
        setState((previous) => ({
          ...previous,
          requestedRange: range,
          isInitialLoading: false,
          isRefreshing: false,
          isStale: previous.result !== null,
          error: errorMessage(error),
        }));
      }
    }

    if (!fresh) void load();

    const scheduleRefresh = () => {
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        if (signal.aborted) return;
        void load().then(() => {
          if (!signal.aborted) scheduleRefresh();
        });
      }, TOKEN_HISTORY_REFRESH_MS);
    };
    scheduleRefresh();

    return () => {
      ac.abort();
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
      if (requestPromise !== undefined && inFlightHistory.get(cacheKey) === requestPromise) {
        inFlightHistory.delete(cacheKey);
      }
    };
  }, [cacheKey, cluster, range, retryNonce]);

  const retry = useCallback(() => {
    if (!inFlightHistory.has(cacheKey)) setRetryNonce((current) => current + 1);
  }, [cacheKey]);

  return {
    ...state,
    requestedRange: range,
    retry,
  };
}
