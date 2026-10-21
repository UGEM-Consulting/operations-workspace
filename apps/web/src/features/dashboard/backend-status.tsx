import { RefreshHealth } from "./refresh-health";
import { Activity } from "lucide-react";
import { Card } from "@/components/ui/card";
import { getBackendHealth } from "@/lib/health";
export function HealthLoading() {
  return <Card className="p-6" role="status"><p className="text-sm font-semibold">System connection</p><p className="mt-3 animate-pulse text-sm text-muted-foreground">Checking backend connectivity…</p></Card>;
}
export async function BackendStatus() {
  const healthy = await getBackendHealth();
  return <Card className="p-6" role="status"><div className="flex items-center justify-between"><h2 className="text-sm font-semibold">System connection</h2><Activity className="size-4 text-muted-foreground" /></div><p className="mt-5 flex items-center gap-2 font-semibold"><span className={`size-2 rounded-full ${healthy ? "bg-emerald-500" : "bg-amber-500"}`} />{healthy ? "Backend connected" : "Backend unavailable"}</p><p className="mt-2 text-sm leading-6 text-muted-foreground">{healthy ? "The API is responding and PostgreSQL is connected." : "The API could not be reached or its health check failed. Check the API and database, then try again."}</p><RefreshHealth /></Card>;
}
