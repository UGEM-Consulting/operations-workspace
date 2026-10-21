import { brand } from '@/lib/brand';
import { cn } from '@/lib/utils';

/** Text-based identity, not a reproduction of an unverified logo. */
export function BrandWordmark({ className }: { className?: string }) {
  return <div className={cn('min-w-0', className)}>
    <p className="font-display text-2xl leading-tight tracking-normal">{brand.companyName}</p>
    <p className="mt-1 text-xs font-medium text-muted-foreground">{brand.applicationName}</p>
  </div>;
}
