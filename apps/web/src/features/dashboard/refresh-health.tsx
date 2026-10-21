"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
export function RefreshHealth() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return <Button variant="ghost" className="mt-4 -ml-3 text-xs text-primary" disabled={pending} onClick={() => startTransition(() => router.refresh())}><RefreshCw className="size-3" />{pending ? "Checking…" : "Check again"}</Button>;
}
