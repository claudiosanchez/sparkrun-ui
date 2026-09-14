import { z } from "zod";

/** Portable model-readiness shape shared by server collection and browser telemetry. */
export const ServiceHealthSchema = z.object({
  cluster: z.string(),
  host: z.string().nullable(),
  state: z.enum(["ready", "unavailable"]),
  model: z.string().nullable(),
});
export type ServiceHealth = z.infer<typeof ServiceHealthSchema>;
