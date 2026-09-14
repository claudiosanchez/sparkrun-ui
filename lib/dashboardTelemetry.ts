import { z } from "zod";
import { MonitorTickSchema } from "./monitor";
import { ClusterStatusSchema } from "./schemas";
import { ServiceHealthSchema } from "./serviceHealth";
import {
  TokenHistoryTelemetryEventSchema,
  TokenHistoryTelemetryPublishEventSchema,
} from "./tokenHistoryTelemetry";
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
  payload: MonitorTickSchema.nullable(),
}).strict();

const OverviewMonitorEventSchema = EventEnvelopeSchema.extend({
  topic: z.literal("overview-monitor"),
  payload: MonitorTickSchema.nullable(),
}).strict();

const StatusEventSchema = EventEnvelopeSchema.extend({
  topic: z.literal("status"),
  cluster: z.string().min(1),
  payload: ClusterStatusSchema.nullable(),
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
  TokenHistoryTelemetryEventSchema,
]);
export type DashboardTelemetryEvent = z.infer<typeof DashboardTelemetryEventSchema>;

export type DashboardTelemetryKey =
  | { topic: "overview-monitor" }
  | {
      topic: Exclude<DashboardTelemetryEvent["topic"], "overview-monitor">;
      cluster: string;
    };

const DashboardTelemetryPublishEventSchema = z.discriminatedUnion("topic", [
  VllmEventSchema.omit({ version: true, revision: true }),
  MonitorEventSchema.omit({ version: true, revision: true }),
  OverviewMonitorEventSchema.omit({ version: true, revision: true }),
  StatusEventSchema.omit({ version: true, revision: true }),
  ServiceEventSchema.omit({ version: true, revision: true }),
  TokenHistoryTelemetryPublishEventSchema,
]);
export type DashboardTelemetryPublishEvent = z.input<typeof DashboardTelemetryPublishEventSchema>;

export type DashboardTelemetrySubscription = AsyncIteratorObject<DashboardTelemetryEvent> & {
  close: () => void;
  readonly pendingEventCount: number;
  return: (value?: unknown) => Promise<IteratorResult<DashboardTelemetryEvent>>;
  [Symbol.asyncDispose]: () => Promise<void>;
};

export type DashboardTelemetryBroker = {
  readonly activeSubscriptionCount: number;
  publish: (event: DashboardTelemetryPublishEvent) => DashboardTelemetryEvent;
  evict: (key: DashboardTelemetryKey) => void;
  subscribe: (signal?: AbortSignal) => DashboardTelemetrySubscription;
  closeSubscriptions: () => void;
};

function eventKey(event: DashboardTelemetryEvent): string {
  return event.topic === "overview-monitor" ? event.topic : `${event.topic}\u0000${event.cluster}`;
}

function telemetryKey(key: DashboardTelemetryKey): string {
  return key.topic === "overview-monitor" ? key.topic : `${key.topic}\u0000${key.cluster}`;
}

type ManagedSubscription = DashboardTelemetrySubscription & {
  push: (event: DashboardTelemetryEvent) => void;
  evict: (key: string) => void;
};

function assertWireSafeJson(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new TypeError("Dashboard telemetry must contain wire-safe finite numbers");
  }
  if (typeof value !== "object") {
    throw new TypeError("Dashboard telemetry must contain only wire-safe JSON values");
  }
  if (ancestors.has(value)) {
    throw new TypeError("Dashboard telemetry must be wire-safe and cannot contain cycles");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (const key of Reflect.ownKeys(value)) {
        if (key === "length") continue;
        const index = typeof key === "string" ? Number(key) : Number.NaN;
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= value.length ||
          String(index) !== key
        ) {
          throw new TypeError("Dashboard telemetry arrays must contain only wire-safe values");
        }
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new TypeError(
            "Dashboard telemetry arrays must not contain empty slots or accessors",
          );
        }
        assertWireSafeJson(descriptor.value, ancestors);
      }
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Dashboard telemetry must contain only wire-safe plain objects");
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new TypeError("Dashboard telemetry must not contain symbol keys");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TypeError("Dashboard telemetry must not contain accessors");
      }
      assertWireSafeJson(descriptor.value, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function cloneWireValue(value: unknown): unknown {
  try {
    assertWireSafeJson(value);
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError("Dashboard telemetry must contain only wire-safe JSON values");
    }
    return JSON.parse(serialized) as unknown;
  } catch (error) {
    if (error instanceof TypeError && error.message.includes("wire-safe")) throw error;
    throw new TypeError("Dashboard telemetry must contain only wire-safe JSON values", {
      cause: error,
    });
  }
}

function cloneEvent(event: unknown): DashboardTelemetryEvent {
  const validated = DashboardTelemetryEventSchema.parse(event);
  return DashboardTelemetryEventSchema.parse(cloneWireValue(validated));
}

function createLatestEventQueue(
  initialEvents: readonly DashboardTelemetryEvent[],
  signal: AbortSignal | undefined,
  onClose: () => void,
): ManagedSubscription {
  const pending = new Map(initialEvents.map((event) => [eventKey(event), cloneEvent(event)]));
  let waiting: ((result: IteratorResult<DashboardTelemetryEvent>) => void) | null = null;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener("abort", close);
    pending.clear();
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
    pending.set(eventKey(copy), copy);
  };

  const subscription: ManagedSubscription = {
    close,
    get pendingEventCount() {
      return pending.size;
    },
    push,
    evict: (key) => {
      pending.delete(key);
    },
    next: () => {
      const first = pending.entries().next();
      if (!first.done) {
        const [key, event] = first.value;
        pending.delete(key);
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
  const subscriptions = new Set<ManagedSubscription>();
  let revision = 0;

  return {
    get activeSubscriptionCount() {
      return subscriptions.size;
    },
    publish(input) {
      const parsed = DashboardTelemetryPublishEventSchema.parse(input);
      const nextRevision = revision + 1;
      const isolated = cloneEvent({
        ...parsed,
        version: 1,
        revision: nextRevision,
      });
      revision = nextRevision;
      cached.set(eventKey(isolated), isolated);
      for (const subscription of subscriptions) subscription.push(isolated);
      return cloneEvent(isolated);
    },
    evict(key) {
      const eventKeyToEvict = telemetryKey(key);
      cached.delete(eventKeyToEvict);
      for (const subscription of subscriptions) subscription.evict(eventKeyToEvict);
    },
    subscribe(signal) {
      const snapshot = [...cached.values()];
      const holder: { subscription?: ManagedSubscription } = {};
      const subscription = createLatestEventQueue(snapshot, signal, () => {
        if (holder.subscription) subscriptions.delete(holder.subscription);
      }) as ManagedSubscription;
      holder.subscription = subscription;
      if (!signal?.aborted) subscriptions.add(subscription);
      return subscription;
    },
    closeSubscriptions() {
      for (const subscription of [...subscriptions]) subscription.close();
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
