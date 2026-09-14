import { os, eventIterator } from "@orpc/server";
import { z } from "zod";
import { ClusterStatusSchema, type ClusterStatus } from "@/lib/schemas";
import { runSparkrunJson } from "@/lib/sparkrun";

const StatusInputSchema = z
  .object({
    cluster: z.string().min(1).optional(),
    intervalMs: z.number().int().min(500).max(30_000).optional(),
  })
  .optional();

export async function fetchStatus(cluster?: string, signal?: AbortSignal): Promise<ClusterStatus> {
  const args = ["cluster", "status"];
  if (cluster) args.push("--cluster", cluster);
  args.push("--json");
  const raw = signal
    ? await runSparkrunJson<unknown>(args, { signal })
    : await runSparkrunJson<unknown>(args);
  return ClusterStatusSchema.parse(raw);
}

export const get = os
  .input(StatusInputSchema)
  .output(ClusterStatusSchema)
  .handler(({ input }) => fetchStatus(input?.cluster));

export const stream = os
  .input(StatusInputSchema)
  .output(eventIterator(ClusterStatusSchema))
  .handler(async function* ({ input, signal }) {
    const interval = input?.intervalMs ?? 3000;
    while (!signal?.aborted) {
      try {
        yield await fetchStatus(input?.cluster, signal);
      } catch (err) {
        console.error("[status.stream]", err);
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  });
