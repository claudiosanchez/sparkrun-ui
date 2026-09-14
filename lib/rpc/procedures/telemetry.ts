import { eventIterator, os } from "@orpc/server";
import { z } from "zod";
import {
  DashboardTelemetryEventSchema,
  getProductionDashboardTelemetryBroker,
} from "@/lib/dashboardTelemetry";
import { startDashboardTelemetryRuntime } from "@/lib/dashboardTelemetryRuntime";
import { startTokenHistoryRecorder } from "@/lib/tokenHistoryRecorder";

export const stream = os
  .input(z.object({}).strict())
  .output(eventIterator(DashboardTelemetryEventSchema))
  .handler(({ signal }) => {
    startTokenHistoryRecorder();
    startDashboardTelemetryRuntime();
    return getProductionDashboardTelemetryBroker().subscribe(signal);
  });
