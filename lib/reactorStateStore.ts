import type { ReactorState } from "./reactorState";

type Listener = () => void;

export function createReactorStateStore(initial: Record<string, ReactorState>) {
  const states = { ...initial };
  const listeners = new Map<string, Set<Listener>>();

  return {
    getSnapshot(name: string) {
      return states[name];
    },

    publish(name: string, next: ReactorState) {
      if (states[name] === next) return;
      states[name] = next;
      listeners.get(name)?.forEach((listener) => listener());
    },

    subscribe(name: string, listener: Listener) {
      let clusterListeners = listeners.get(name);
      if (!clusterListeners) {
        clusterListeners = new Set();
        listeners.set(name, clusterListeners);
      }
      clusterListeners.add(listener);
      return () => {
        clusterListeners.delete(listener);
        if (clusterListeners.size === 0) listeners.delete(name);
      };
    },
  };
}

export type ReactorStateStore = ReturnType<typeof createReactorStateStore>;
