import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface Column<T> {
  key: string; label: string; cell: (row: T) => ReactNode;
  /** Identifies the record; the title of each stacked row on phones. */
  primary?: boolean;
  /** The one visible row action; top right of each stacked row on phones. */
  action?: boolean;
  align?: 'right'; nowrap?: boolean; mono?: boolean; muted?: boolean; srOnly?: boolean;
  /** Lower-priority columns leave the table below this width (they still show in stacked rows). */
  hideBelow?: 'md' | 'lg' | 'xl';
  /** Server-side sorting: the URL that sorts by this column, and the current direction when sorted. */
  sort?: { href: string; direction?: 'asc' | 'desc' };
}
const hidden = { md: 'max-md:hidden', lg: 'max-lg:hidden', xl: 'max-xl:hidden' };
// Under 640px each row becomes a small card: the primary cell as title, the action top right, the rest as "label · value".
const stack = 'max-sm:col-span-full max-sm:flex max-sm:flex-wrap max-sm:items-baseline max-sm:gap-x-3 max-sm:p-0 max-sm:text-left max-sm:whitespace-normal max-sm:before:w-28 max-sm:before:shrink-0 max-sm:before:text-[13px] max-sm:before:font-normal max-sm:before:text-muted-foreground max-sm:before:content-[attr(data-label)]';
const stackTitle = 'max-sm:col-span-1 max-sm:row-start-1 max-sm:pb-1 max-sm:before:hidden';
const stackAction = 'max-sm:col-span-1 max-sm:col-start-2 max-sm:row-start-1 max-sm:justify-end max-sm:before:hidden';

/** Rows of records. Sorting, search and pagination happen on the server; put it in a Card and pass Pagination as the footer. */
export function Table<T>({ caption, columns, rows, rowKey, rowClassName, dense = false, empty, footer, className }: {
  caption: string; columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string; rowClassName?: (row: T) => string | undefined;
  dense?: boolean; empty?: ReactNode; footer?: ReactNode; className?: string;
}) {
  return <div className={cn('min-w-0', className)}>
    <div className="overflow-x-auto max-sm:overflow-visible">
      <table className="w-full border-collapse text-left text-sm max-sm:block">
        <caption className="sr-only">{caption}</caption>
        <thead className="max-sm:hidden"><tr>{columns.map(column => {
          const Icon = column.sort?.direction === 'asc' ? ArrowUp : column.sort?.direction === 'desc' ? ArrowDown : ChevronsUpDown;
          return <th key={column.key} scope="col" aria-sort={column.sort?.direction ? (column.sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}
            className={cn('h-10 whitespace-nowrap border-b border-border bg-muted px-4 text-xs font-medium text-muted-foreground', column.align === 'right' && 'text-right', column.hideBelow && hidden[column.hideBelow])}>
            {column.srOnly ? <span className="sr-only">{column.label}</span> : column.sort
              ? <Link href={column.sort.href} className={cn('-mx-1.5 inline-flex items-center gap-1 rounded-xs px-1.5 py-1 hover:text-foreground', column.sort.direction && 'text-foreground')}>{column.label}<Icon aria-hidden="true" className="size-3.5" /></Link>
              : column.label}
          </th>;
        })}</tr></thead>
        {rows.length > 0 && <tbody className="max-sm:block">{rows.map(row => <tr key={rowKey(row)} className={cn('border-b border-border transition-colors last:border-0 hover:bg-accent max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:gap-x-3 max-sm:gap-y-1 max-sm:px-4 max-sm:py-3', rowClassName?.(row))}>
          {columns.map(column => {
            const labelled = !column.primary && !column.action && !column.srOnly;
            return <td key={column.key} data-label={labelled ? column.label : undefined}
              className={cn('px-4 align-middle', dense ? 'py-2' : 'py-3', column.align === 'right' && 'text-right', column.nowrap && 'whitespace-nowrap', column.mono && 'font-mono text-[13px]', column.muted && 'text-muted-foreground',
                column.hideBelow && hidden[column.hideBelow], stack, !labelled && 'max-sm:before:hidden', column.primary && stackTitle, column.action && stackAction)}><div className="min-w-0 max-sm:flex-1">{column.cell(row)}</div></td>;
          })}
        </tr>)}</tbody>}
      </table>
    </div>
    {rows.length === 0 && empty && <div className="border-t border-border max-sm:border-0">{empty}</div>}
    {footer && <div className="border-t border-border px-4 py-2.5">{footer}</div>}
  </div>;
}
