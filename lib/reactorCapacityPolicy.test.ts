import { describe, expect, it } from "vitest";
import { applyReactorCapacityPolicies, loadReactorCapacityPolicies } from "./reactorCapacityPolicy";

describe("reactor capacity policy", () => {
  it("loads a named policy and enriches only that saved cluster", async () => {
    const readFile = async () =>
      JSON.stringify({
        clusters: { c032: { safe_concurrent_requests: 4, queue_budget: 16 } },
      });
    const policies = await loadReactorCapacityPolicies({ readFile, path: "/policy.json" });

    expect(
      applyReactorCapacityPolicies(
        [
          { name: "c032", hosts: ["a"], is_default: true },
          { name: "future", hosts: ["b"], is_default: false },
        ],
        policies,
      ),
    ).toEqual([
      expect.objectContaining({
        name: "c032",
        reactorCapacity: { safeConcurrentRequests: 4, queueBudget: 16 },
      }),
      expect.objectContaining({ name: "future", reactorCapacity: undefined }),
    ]);
  });

  it("returns no policy when the file is absent or a target is invalid", async () => {
    await expect(
      loadReactorCapacityPolicies({
        path: "/missing.json",
        readFile: async () => {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
      }),
    ).resolves.toEqual({});
    await expect(
      loadReactorCapacityPolicies({
        path: "/invalid.json",
        readFile: async () =>
          JSON.stringify({
            clusters: { c032: { safe_concurrent_requests: 0, queue_budget: 4 } },
          }),
      }),
    ).resolves.toEqual({});
  });

  it("uses the explicit policy path instead of the platform default", async () => {
    let loadedPath = "";
    await loadReactorCapacityPolicies({
      environment: { SPARKRUN_UI_REACTOR_CAPACITY_POLICY_PATH: "/explicit-policy.json" },
      hostPlatform: "darwin",
      homeDirectory: "/home/operator",
      readFile: async (path) => {
        loadedPath = path;
        return JSON.stringify({ clusters: {} });
      },
    });

    expect(loadedPath).toBe("/explicit-policy.json");
  });

  it("does not inherit policies for prototype-named clusters", () => {
    const prototypeNames = ["constructor", "toString", "__proto__"];
    const clusters = prototypeNames.map((name) => ({ name, hosts: [], is_default: false }));

    expect(applyReactorCapacityPolicies(clusters, {})).toEqual(
      prototypeNames.map((name) => expect.objectContaining({ name, reactorCapacity: undefined })),
    );

    const policies = Object.create(null) as Record<
      string,
      { safeConcurrentRequests: number; queueBudget: number }
    >;
    policies.__proto__ = { safeConcurrentRequests: 4, queueBudget: 16 };
    expect(applyReactorCapacityPolicies([clusters[2]], policies)).toEqual([
      expect.objectContaining({
        name: "__proto__",
        reactorCapacity: { safeConcurrentRequests: 4, queueBudget: 16 },
      }),
    ]);
  });
});
