import { expect, it } from "vitest";
import { appendReactorTrend } from "./reactorTrend";

it("keeps independent bounded CPU and GPU trends for one cluster stream", () => {
  const history = appendReactorTrend(
    { cpu: [5, 10, 20], gpu: [30, 40, 45] },
    { cpu: 25, gpu: 50 },
    3,
  );

  expect(history).toEqual({ cpu: [10, 20, 25], gpu: [40, 45, 50] });
});
