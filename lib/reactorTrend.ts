export type ReactorTrend = { cpu: number[]; gpu: number[] };

export function appendReactorTrend(
  previous: ReactorTrend,
  next: { cpu: number | null; gpu: number | null },
  limit: number,
): ReactorTrend {
  return {
    cpu: next.cpu === null ? previous.cpu : append(previous.cpu, next.cpu, limit),
    gpu: next.gpu === null ? previous.gpu : append(previous.gpu, next.gpu, limit),
  };
}

function append(values: number[], value: number, limit: number): number[] {
  const next = values.concat(value);
  return next.length > limit ? next.slice(-limit) : next;
}
