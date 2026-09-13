import { os, eventIterator } from "@orpc/server";
import { z } from "zod";
import { streamSparkrunNdjson } from "@/lib/sparkrun";
import { MonitorTickSchema } from "@/lib/monitor";

export const stream = os
  .input(
    z
      .object({
        cluster: z.string().optional(),
        hosts: z.array(z.string()).optional(),
        intervalSec: z.number().int().min(1).max(30).default(2),
      })
      .optional(),
  )
  .output(eventIterator(MonitorTickSchema))
  .handler(async function* ({ input, signal }) {
    const args = ["cluster", "monitor", "--json", "--interval", String(input?.intervalSec ?? 2)];
    if (input?.cluster) args.push("--cluster", input.cluster);
    else if (input?.hosts?.length) args.push("--hosts", input.hosts.join(","));
    for await (const obj of streamSparkrunNdjson<z.infer<typeof MonitorTickSchema>>(args, { signal })) {
      if (signal?.aborted) break;
      yield obj;
    }
  });
