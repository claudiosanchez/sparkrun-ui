import { readFile as readNativeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ClusterEntry, ReactorCapacityPolicy } from "./schemas";

const policyFileSchema = z
  .object({
    clusters: z.record(
      z.string(),
      z
        .object({
          safe_concurrent_requests: z.number().int().positive(),
          queue_budget: z.number().int().positive(),
        })
        .strict(),
    ),
  })
  .strict();

type ReadFile = (path: string, encoding: "utf8") => Promise<string>;
type Environment = Readonly<Record<string, string | undefined>>;

export type LoadReactorCapacityPoliciesOptions = {
  environment?: Environment;
  homeDirectory?: string;
  hostPlatform?: NodeJS.Platform;
  path?: string;
  readFile?: ReadFile;
  warn?: (message: string) => void;
};

function defaultPolicyPath(
  environment: Environment,
  hostPlatform: NodeJS.Platform,
  homeDirectory: string,
): string {
  const configured = environment.SPARKRUN_UI_REACTOR_CAPACITY_POLICY_PATH?.trim();
  if (configured) return configured;

  if (hostPlatform === "darwin") {
    return join(
      homeDirectory,
      "Library",
      "Application Support",
      "sparkrun-ui",
      "reactor-capacity.json",
    );
  }
  if (hostPlatform === "win32") {
    return join(
      environment.APPDATA || join(homeDirectory, "AppData", "Roaming"),
      "sparkrun-ui",
      "reactor-capacity.json",
    );
  }
  return join(homeDirectory, ".config", "sparkrun-ui", "reactor-capacity.json");
}

/** Load optional operating targets for the Dashboard's saved clusters. */
export async function loadReactorCapacityPolicies(
  options: LoadReactorCapacityPoliciesOptions = {},
): Promise<Record<string, ReactorCapacityPolicy>> {
  const environment = options.environment ?? process.env;
  const policyPath =
    options.path ??
    defaultPolicyPath(
      environment,
      options.hostPlatform ?? platform(),
      options.homeDirectory ?? homedir(),
    );
  const readFile = options.readFile ?? ((path, encoding) => readNativeFile(path, encoding));
  const warn = options.warn ?? console.warn;

  let parsed: z.infer<typeof policyFileSchema>;
  try {
    parsed = policyFileSchema.parse(JSON.parse(await readFile(policyPath, "utf8")));
  } catch {
    warn(
      `Reactor capacity policy is unavailable or invalid at ${policyPath}; targets are not set.`,
    );
    return {};
  }

  return Object.fromEntries(
    Object.entries(parsed.clusters).map(([name, policy]) => [
      name,
      {
        safeConcurrentRequests: policy.safe_concurrent_requests,
        queueBudget: policy.queue_budget,
      },
    ]),
  );
}

/** Attach configured operating targets without changing saved-cluster topology. */
export function applyReactorCapacityPolicies(
  clusters: readonly ClusterEntry[],
  policies: Readonly<Record<string, ReactorCapacityPolicy>>,
): ClusterEntry[] {
  return clusters.map((cluster) => {
    const policy = Object.prototype.hasOwnProperty.call(policies, cluster.name)
      ? policies[cluster.name]
      : undefined;
    return { ...cluster, reactorCapacity: policy };
  });
}
