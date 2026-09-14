"use client";

import { useEffect, type ReactNode } from "react";
import { rpc } from "@/lib/rpc/client";
import { tokenHistoryTelemetryStore } from "./tokenHistoryTelemetryStore";

const RETRY_DELAY_MS = 3_000;

function waitForRetry(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, RETRY_DELAY_MS);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

export function TokenHistoryTelemetryProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    async function subscribe(): Promise<void> {
      while (!signal.aborted) {
        try {
          const stream = await rpc.telemetry.stream({}, { signal });
          tokenHistoryTelemetryStore.setConnectionHealthy(true);
          for await (const event of stream) {
            if (signal.aborted) return;
            tokenHistoryTelemetryStore.publish(event);
          }
        } catch {
          // The bounded store retains observations while the shared stream reconnects.
        } finally {
          tokenHistoryTelemetryStore.setConnectionHealthy(false);
        }
        if (!signal.aborted) await waitForRetry(signal);
      }
    }

    void subscribe();
    return () => {
      controller.abort();
      tokenHistoryTelemetryStore.setConnectionHealthy(false);
    };
  }, []);

  return children;
}
