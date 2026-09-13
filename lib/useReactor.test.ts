import { afterEach, describe, expect, it, vi } from "vitest";
import { healthSignal } from "@/app/components/dashboard/useReactor";

describe("healthSignal", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("aborts after four seconds and when its owner unmounts", () => {
    const timeout = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(timeout.signal);
    const owner = new AbortController();
    const bounded = healthSignal(owner.signal);

    expect(timeoutSpy).toHaveBeenCalledWith(4_000);
    expect(bounded.aborted).toBe(false);

    owner.abort();
    expect(bounded.aborted).toBe(true);

    const separateOwner = new AbortController();
    const separateBounded = healthSignal(separateOwner.signal);
    timeout.abort();
    expect(separateBounded.aborted).toBe(true);
  });
});
