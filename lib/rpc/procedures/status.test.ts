import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchStatus } from "./status";
import { runSparkrunJson } from "@/lib/sparkrun";

vi.mock("@/lib/sparkrun", () => ({
  runSparkrunJson: vi.fn(),
}));

describe("fetchStatus", () => {
  const status = {
    groups: {},
    solo_entries: [],
    idle_hosts: [],
    pending_ops: [],
    errors: {},
    total_containers: 0,
    host_count: 0,
  };

  beforeEach(() => {
    vi.mocked(runSparkrunJson).mockReset();
    vi.mocked(runSparkrunJson).mockResolvedValue(status);
  });

  it("fetches default status without cluster parameter", async () => {
    await fetchStatus();

    expect(runSparkrunJson).toHaveBeenCalledWith(["cluster", "status", "--json"]);
  });

  it("fetches status for a named cluster", async () => {
    await fetchStatus("c458");

    expect(runSparkrunJson).toHaveBeenCalledWith([
      "cluster",
      "status",
      "--cluster",
      "c458",
      "--json",
    ]);
  });
});
