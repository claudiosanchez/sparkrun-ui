import { os } from "@orpc/server";
import { z } from "zod";
import { runSparkrunJson } from "@/lib/sparkrun";

const SavedClusterSchema = z.object({
  name: z.string(),
  hosts: z.array(z.string()).default([]),
});

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

export async function healthForCluster(cluster: string): Promise<ServiceHealth> {
  let savedClusters: z.infer<typeof SavedClusterSchema>[];
  try {
    const raw = await runSparkrunJson<unknown>(["cluster", "list", "--json"]);
    savedClusters = z.array(SavedClusterSchema).parse(raw);
  } catch {
    return unavailable(cluster, null);
  }

  const savedCluster = savedClusters.find((entry) => entry.name === cluster);
  const host = savedCluster?.hosts[0] ?? null;
  if (!host) return unavailable(cluster, null);

  try {
    const response = await fetch(`http://${host}:8000/v1/models`, {
      signal: AbortSignal.timeout(3_000),
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
  .handler(({ input }) => healthForCluster(input.cluster));
