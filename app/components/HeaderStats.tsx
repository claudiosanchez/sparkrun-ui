"use client";
import { useEffect, useState } from "react";
import { Thermometer, Zap } from "lucide-react";
import { usePathname } from "next/navigation";
import { rpc } from "@/lib/rpc/client";
import { MonitorTick, monitorHostViews } from "@/lib/monitor";

function num(s: string | undefined): number {
  if (!s) return 0;
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : 0;
}

interface Stats {
  gpuPct: number;
  gpuTempC: number;
  connected: boolean;
}

const initial: Stats = { gpuPct: 0, gpuTempC: 0, connected: false };

export function HeaderStats() {
  const [stats, setStats] = useState<Stats>(initial);
  const pathname = usePathname();

  useEffect(() => {
    if (pathname === "/dashboard") return;

    const ac = new AbortController();
    let cancelled = false;
    (async () => {
      try {
        const iter = await rpc.monitor.stream({ intervalSec: 3 }, { signal: ac.signal });
        for await (const next of iter) {
          if (cancelled) break;
          const tick = next as MonitorTick;
          const views = monitorHostViews(tick);
          const samples = Object.values(views).flatMap((host) =>
            host.sample ? [host.sample] : [],
          );
          let gpuSum = 0;
          let tempSum = 0;
          for (const s of samples) {
            gpuSum += num(s.gpu_util_pct);
            tempSum += num(s.gpu_temp_c);
          }
          const n = samples.length || 1;
          setStats({
            gpuPct: gpuSum / n,
            gpuTempC: tempSum / n,
            connected: true,
          });
        }
      } catch {
        if (!cancelled) setStats((s) => ({ ...s, connected: false }));
      }
    })();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [pathname]);

  if (pathname === "/dashboard") return null;
  if (!stats.connected && stats.gpuPct === 0) return null;

  return (
    <div className="flex items-center gap-3 text-xs text-zinc-500 dark:text-zinc-400">
      <span className="flex items-center gap-1" title="GPU utilization">
        <Zap size={12} className={stats.gpuPct > 0 ? "text-purple-500" : "text-zinc-400"} />
        {stats.gpuPct.toFixed(0)}%
      </span>
      {stats.gpuTempC > 0 && (
        <span className="flex items-center gap-1" title="GPU temperature">
          <Thermometer size={12} className="text-red-500" />
          {stats.gpuTempC.toFixed(0)}°C
        </span>
      )}
    </div>
  );
}
