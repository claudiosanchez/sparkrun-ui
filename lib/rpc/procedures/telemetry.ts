import { eventIterator, os } from "@orpc/server";
import { z } from "zod";
import {
  DashboardTelemetryEventSchema,
  getProductionDashboardTelemetryBroker,
} from "@/lib/dashboardTelemetry";

export const stream = os
  .input(z.object({}).strict())
  .output(eventIterator(DashboardTelemetryEventSchema))
  .handler(({ signal }) => getProductionDashboardTelemetryBroker().subscribe(signal));
