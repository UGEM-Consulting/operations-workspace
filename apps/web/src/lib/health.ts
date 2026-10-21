import "server-only";
export async function getBackendHealth(): Promise<boolean> {
  try {
    const base = process.env.API_BASE_URL ?? "http://localhost:4000";
    const response = await fetch(`${base.replace(/\/$/, "")}/api/health`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!response.ok) return false;
    const data: unknown = await response.json();
    return typeof data === "object" && data !== null && "status" in data && data.status === "ok" && "database" in data && data.database === "connected";
  } catch { return false; }
}
