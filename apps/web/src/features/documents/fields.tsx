'use client';
import type { CSSProperties, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type FieldKind = 'SIGNATURE' | 'NAME' | 'AMERICAN_NAME' | 'DATE' | 'DAY' | 'MONTH' | 'YEAR' | 'TITLE';
export type FieldSigner = 'SIGNER' | 'COMPANY';
/** A place to fill in, as fractions of the page as shown, from its top left. */
export interface DocumentField { page: number; x: number; y: number; width: number; height: number; kind: FieldKind; signer: FieldSigner }

// The date on a form is the day it was signed in the US Eastern zone, the same rule as the API's copies.
const part = (at: Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', ...options }).format(at);
export function fieldText(kind: FieldKind, values: { name?: string; american?: string; title?: string; at: Date }): string {
  switch (kind) {
    case 'NAME': return values.name ?? '';
    case 'AMERICAN_NAME': return values.american ?? '';
    case 'TITLE': return values.title ?? '';
    case 'DATE': return part(values.at, { month: 'long', day: 'numeric', year: 'numeric' });
    case 'DAY': return part(values.at, { day: 'numeric' });
    case 'MONTH': return part(values.at, { month: 'long' });
    case 'YEAR': return part(values.at, { year: '2-digit' });
    default: return '';
  }
}
export const fieldLabels: Record<FieldKind, string> = { SIGNATURE: 'Signature', NAME: 'Full legal name', AMERICAN_NAME: 'American name', DATE: 'Date signed', DAY: 'Day', MONTH: 'Month', YEAR: 'Year (2 digits)', TITLE: 'Title' };

const box = (field: DocumentField): CSSProperties => ({ left: `${field.x * 100}%`, top: `${field.y * 100}%`, width: `${field.width * 100}%`, height: `${field.height * 100}%` });
const INK = '#14215c';
/** One field on a page: filled in with text or a signature, or marked as still to fill. */
export function FieldMark({ field, pageHeight, pageWidth, text, image, label, active = false, grow = false, children }: { field: DocumentField; pageHeight: number; pageWidth: number; text?: string; image?: string; label?: string; active?: boolean; /** Keeps the label however small the page. */ grow?: boolean; children?: ReactNode }) {
  const height = field.height * pageHeight, width = field.width * pageWidth;
  if (image) {
    // eslint-disable-next-line @next/next/no-img-element -- a data URL the signer just made
    return <img src={image} alt="" className="pointer-events-none absolute object-contain object-left-bottom" style={box(field)} />;
  }
  if (text) {
    // Sized as the signed copy is, so what they see is what's stamped.
    const fit = Math.min(height * 0.8, 13 * (pageHeight / 792) * 1.0, width / Math.max(text.length * 0.5, 1));
    return <span className={cn('pointer-events-none absolute flex items-end overflow-hidden whitespace-nowrap font-serif', ['DAY', 'MONTH', 'YEAR'].includes(field.kind) && 'justify-center')} style={{ ...box(field), fontSize: fit, lineHeight: 1, color: INK, paddingBottom: height * 0.14, paddingLeft: ['DAY', 'MONTH', 'YEAR'].includes(field.kind) ? 0 : 2 * (pageHeight / 792) }}>{text}</span>;
  }
  // On a page shrunk to fit a phone a label won't fit its line, and must never cover the words around it: the space is a light band on the line.
  if (!grow && (height < 12 || width < (label?.length ?? 8) * 5.2 + 6)) return <span aria-hidden="true" title={label} className={cn('absolute rounded-[2px] border-b', field.signer === 'COMPANY' ? 'border-indigo-500 bg-indigo-500/15' : 'border-orange-700 bg-orange-500/20', active && 'outline-1 outline-offset-1 outline-orange-700')} style={box(field)} />;
  // While placing fields the label says which is which, so that mark grows up from its line and out past its width.
  const tall = Math.max(height, 13);
  return <span className={cn('absolute flex min-w-fit items-center justify-center overflow-hidden whitespace-nowrap rounded-[3px] border border-dashed px-0.5 font-sans font-semibold leading-none', field.signer === 'COMPANY' ? 'border-indigo-500 bg-indigo-50/90 text-indigo-800' : 'border-orange-700 bg-orange-50/90 text-orange-800', active && 'outline-2 outline-offset-1 outline-orange-700')}
    style={{ ...box(field), height: tall, transform: `translateY(${height - tall}px)`, fontSize: Math.max(9, Math.min(height * 0.55, 11, width / Math.max((label?.length ?? 8) * 0.55, 1))) }}>{label}{children}</span>;
}
