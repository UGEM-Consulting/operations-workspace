import "server-only";
import { readBackendConfig } from "./backend-connection";
export async function getBackendHealth(): Promise<boolean> {
  try {
    // The same validated API origin as every other server call; a missing or invalid configuration reports unhealthy.
    const { base } = readBackendConfig(process.env);
    const response = await fetch(`${base}/api/health`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!response.ok) return false;
    const data: unknown = await response.json();
    return typeof data === "object" && data !== null && "status" in data && data.status === "ok" && "database" in data && data.database === "connected";
  } catch { return false; }
}
