/** Start server-owned telemetry collection without affecting the UI startup path. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { startTokenHistoryRecorder } = await import("./lib/tokenHistoryRecorder");
    const { startDashboardTelemetryRuntime } = await import("./lib/dashboardTelemetryRuntime");
    startTokenHistoryRecorder();
    startDashboardTelemetryRuntime();
  } catch {
    // Collection is best effort. The dashboard must still start if discovery
    // or application-owned storage is unavailable.
  }
}
