import { z } from "zod";

export const MonitorSampleSchema = z.object({}).catchall(z.string());
export const MonitorHostSchema = z.object({
  host: z.string(),
  error: z.unknown().nullable().default(null),
  sample: MonitorSampleSchema.nullable().default(null),
  workloads: z.array(z.unknown()).default([]),
  used_slots: z.number().default(0),
  free_slots: z.number().default(0),
}).loose();
export type MonitorHost = z.infer<typeof MonitorHostSchema>;
export const MonitorTickSchema = z.object({ timestamp: z.number(), hosts: z.array(MonitorHostSchema) });
export type MonitorTick = z.infer<typeof MonitorTickSchema>;

export function monitorHostViews(tick: MonitorTick): Record<string, MonitorHost> {
  return Object.fromEntries(tick.hosts.map((entry) => [entry.host, entry]));
}

export function numberMetric(value: string | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}
