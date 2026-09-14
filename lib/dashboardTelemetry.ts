import { z } from "zod";
import { MonitorTickSchema } from "./monitor";
import { ClusterStatusSchema } from "./schemas";
import { ServiceHealthSchema } from "./rpc/procedures/services";
import { VllmClusterSnapshotSchema } from "./vllmMetrics";

const EventEnvelopeSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  observedAtMs: z.number().int().nonnegative(),
});

const VllmEventSchema = EventEnvelopeSchema.extend({
  topic: z.literal("vllm"),
  cluster: z.string().min(1),
  payload: VllmClusterSnapshotSchema,
}).strict();

const MonitorEventSchema = EventEnvelopeSchema.extend({
  topic: z.literal("monitor"),
  cluster: z.string().min(1),
  payload: MonitorTickSchema,
}).strict();

const OverviewMonitorEventSchema = EventEnvelopeSchema.extend({
  topic: z.literal("overview-monitor"),
  payload: MonitorTickSchema,
}).strict();

const StatusEventSchema = EventEnvelopeSchema.extend({
  topic: z.literal("status"),
  cluster: z.string().min(1),
  payload: ClusterStatusSchema,
}).strict();

const ServiceEventSchema = EventEnvelopeSchema.extend({
  topic: z.literal("service"),
  cluster: z.string().min(1),
  payload: ServiceHealthSchema,
}).strict();

export const DashboardTelemetryEventSchema = z.discriminatedUnion("topic", [
  VllmEventSchema,
  MonitorEventSchema,
  OverviewMonitorEventSchema,
  StatusEventSchema,
  ServiceEventSchema,
]);
export type DashboardTelemetryEvent = z.infer<typeof DashboardTelemetryEventSchema>;

const DashboardTelemetryPublishEventSchema = z.discriminatedUnion("topic", [
  VllmEventSchema.omit({ version: true, revision: true }),
  MonitorEventSchema.omit({ version: true, revision: true }),
  OverviewMonitorEventSchema.omit({ version: true, revision: true }),
  StatusEventSchema.omit({ version: true, revision: true }),
  ServiceEventSchema.omit({ version: true, revision: true }),
]);
export type DashboardTelemetryPublishEvent = z.input<typeof DashboardTelemetryPublishEventSchema>;

export type DashboardTelemetrySubscription = AsyncIteratorObject<DashboardTelemetryEvent> & {
  close: () => void;
  return: (value?: unknown) => Promise<IteratorResult<DashboardTelemetryEvent>>;
  [Symbol.asyncDispose]: () => Promise<void>;
};

export type DashboardTelemetryBroker = {
  readonly activeSubscriptionCount: number;
  publish: (event: DashboardTelemetryPublishEvent) => DashboardTelemetryEvent;
  subscribe: (signal?: AbortSignal) => DashboardTelemetrySubscription;
  closeSubscriptions: () => void;
};

function eventKey(event: DashboardTelemetryEvent): string {
  return event.topic === "overview-monitor" ? event.topic : `${event.topic}\u0000${event.cluster}`;
}

function cloneEvent(event: DashboardTelemetryEvent): DashboardTelemetryEvent {
  return DashboardTelemetryEventSchema.parse(event);
}

function createLatestEventQueue(
  initialEvents: readonly DashboardTelemetryEvent[],
  signal: AbortSignal | undefined,
  onClose: () => void,
): DashboardTelemetrySubscription {
  const cachedPending = initialEvents.map(cloneEvent);
  const livePending = new Map<string, DashboardTelemetryEvent>();
  let waiting: ((result: IteratorResult<DashboardTelemetryEvent>) => void) | null = null;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener("abort", close);
    cachedPending.length = 0;
    livePending.clear();
    const resolve = waiting;
    waiting = null;
    resolve?.({ value: undefined, done: true });
    onClose();
  };

  const push = (event: DashboardTelemetryEvent) => {
    if (closed) return;
    const copy = cloneEvent(event);
    const resolve = waiting;
    if (resolve) {
      waiting = null;
      resolve({ value: copy, done: false });
      return;
    }
    livePending.set(eventKey(copy), copy);
  };

  const subscription: DashboardTelemetrySubscription & {
    push: (event: DashboardTelemetryEvent) => void;
  } = {
    close,
    push,
    next: () => {
      const cachedEvent = cachedPending.shift();
      if (cachedEvent) return Promise.resolve({ value: cachedEvent, done: false });

      const first = livePending.entries().next();
      if (!first.done) {
        const [key, event] = first.value;
        livePending.delete(key);
        return Promise.resolve({ value: event, done: false });
      }
      if (closed) return Promise.resolve({ value: undefined, done: true });
      if (waiting) return Promise.reject(new Error("Only one telemetry read may wait at a time"));
      return new Promise<IteratorResult<DashboardTelemetryEvent>>((resolve) => {
        waiting = resolve;
        if (closed) {
          waiting = null;
          resolve({ value: undefined, done: true });
        }
      });
    },
    return: async () => {
      close();
      return { value: undefined, done: true };
    },
    throw: async (error?: unknown) => {
      close();
      throw error;
    },
    [Symbol.asyncDispose]: async () => {
      close();
    },
    [Symbol.asyncIterator]() {
      return subscription;
    },
  };

  signal?.addEventListener("abort", close, { once: true });
  if (signal?.aborted) close();
  return subscription;
}

export function createDashboardTelemetryBroker(): DashboardTelemetryBroker {
  const cached = new Map<string, DashboardTelemetryEvent>();
  const subscriptions = new Map<
    DashboardTelemetrySubscription,
    DashboardTelemetrySubscription & { push: (event: DashboardTelemetryEvent) => void }
  >();
  let revision = 0;

  return {
    get activeSubscriptionCount() {
      return subscriptions.size;
    },
    publish(input) {
      const parsed = DashboardTelemetryPublishEventSchema.parse(input);
      revision += 1;
      const event = DashboardTelemetryEventSchema.parse({
        ...parsed,
        version: 1,
        revision,
      });
      cached.set(eventKey(event), event);
      for (const subscription of subscriptions.values()) subscription.push(event);
      return cloneEvent(event);
    },
    subscribe(signal) {
      const holder: {
        subscription?: DashboardTelemetrySubscription & {
          push: (event: DashboardTelemetryEvent) => void;
        };
      } = {};
      const subscription = createLatestEventQueue([...cached.values()], signal, () => {
        if (holder.subscription) subscriptions.delete(holder.subscription);
      }) as DashboardTelemetrySubscription & {
        push: (event: DashboardTelemetryEvent) => void;
      };
      holder.subscription = subscription;
      if (!signal?.aborted) subscriptions.set(subscription, subscription);
      return subscription;
    },
    closeSubscriptions() {
      for (const subscription of [...subscriptions.keys()]) subscription.close();
    },
  };
}

declare global {
  var __sparkrunDashboardTelemetryBroker: DashboardTelemetryBroker | undefined;
}

export function getProductionDashboardTelemetryBroker(): DashboardTelemetryBroker {
  if (!globalThis.__sparkrunDashboardTelemetryBroker) {
    globalThis.__sparkrunDashboardTelemetryBroker = createDashboardTelemetryBroker();
  }
  return globalThis.__sparkrunDashboardTelemetryBroker;
}

export function resetProductionDashboardTelemetryBroker(): void {
  globalThis.__sparkrunDashboardTelemetryBroker?.closeSubscriptions();
  globalThis.__sparkrunDashboardTelemetryBroker = undefined;
}
