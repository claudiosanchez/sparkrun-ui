import { os } from "@orpc/server";
import { z } from "zod";
import { runSparkrunJson } from "@/lib/sparkrun";

const SavedClusterSchema = z.object({
  name: z.string(),
  hosts: z.array(z.string()).default([]),
});

const HEALTH_TIMEOUT_MS = 3_000;

function healthSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(HEALTH_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export const ServiceHealthSchema = z.object({
  cluster: z.string(),
  host: z.string().nullable(),
  state: z.enum(["ready", "unavailable"]),
  model: z.string().nullable(),
});
export type ServiceHealth = z.infer<typeof ServiceHealthSchema>;

function unavailable(cluster: string, host: string | null): ServiceHealth {
  return { cluster, host, state: "unavailable", model: null };
}

function modelFromResponse(body: unknown): string | null {
  const parsed = z
    .object({
      data: z.array(z.object({ model: z.string().optional(), id: z.string().optional() })),
    })
    .safeParse(body);
  if (!parsed.success) return null;
  const model = parsed.data.data[0];
  return model?.model ?? model?.id ?? null;
}

export async function healthForCluster(
  cluster: string,
  signal?: AbortSignal,
): Promise<ServiceHealth> {
  const bounded = healthSignal(signal);
  let savedClusters: z.infer<typeof SavedClusterSchema>[];
  try {
    const raw = await runSparkrunJson<unknown>(["cluster", "list", "--json"], {
      signal: bounded,
      timeoutMs: HEALTH_TIMEOUT_MS,
    });
    savedClusters = z.array(SavedClusterSchema).parse(raw);
  } catch {
    return unavailable(cluster, null);
  }

  const savedCluster = savedClusters.find((entry) => entry.name === cluster);
  const host = savedCluster?.hosts[0] ?? null;
  if (!host) return unavailable(cluster, null);

  try {
    const response = await fetch(`http://${host}:8000/v1/models`, {
      signal: bounded,
    });
    if (!response.ok) return unavailable(cluster, host);

    const model = modelFromResponse(await response.json());
    return model ? { cluster, host, state: "ready", model } : unavailable(cluster, host);
  } catch {
    return unavailable(cluster, host);
  }
}

export const health = os
  .input(z.object({ cluster: z.string().min(1) }))
  .output(ServiceHealthSchema)
  .handler(({ input, signal }) => healthForCluster(input.cluster, signal));
