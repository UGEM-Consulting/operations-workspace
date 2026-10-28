import * as React from "react";
import { cn } from "@/lib/utils";
/** The container for one section of a page. Don't nest cards; separate inside with a divider or a muted block. */
export function Card({ className, interactive = false, ...props }: React.ComponentProps<"div"> & { interactive?: boolean }) {
  return <div data-slot="card" className={cn("min-w-0 rounded-lg border border-border bg-card text-card-foreground shadow-xs", interactive && "transition-[border-color,box-shadow] hover:border-border-strong hover:shadow-sm", className)} {...props} />;
}
/** Title, description and at most one primary action (small buttons) at the top right. */
export function CardHeader({ title, description, actions, as: Heading = "h2", className }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; as?: "h2" | "h3"; className?: string }) {
  return <div className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 pt-4 sm:px-5", className)}>
    <div className="min-w-0"><Heading className="text-[15px] font-semibold leading-[22px]">{title}</Heading>{description && <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">{description}</p>}</div>
    {actions && <div className="-mt-1 flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
  </div>;
}
export function CardBody({ className, flush = false, ...props }: React.ComponentProps<"div"> & { flush?: boolean }) {
  return <div className={cn(flush ? "pt-3" : "p-4 sm:px-5 sm:pb-5", className)} {...props} />;
}
export function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3 sm:px-5", className)} {...props} />;
}
