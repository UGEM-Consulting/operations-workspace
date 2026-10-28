import type { ComponentProps, ReactNode } from 'react';
import { ChevronDown, CircleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

// Height and text size follow the page density (44px/16px for applicants and phones, 36px/14px on staff screens).
const control = 'w-full rounded-sm border border-input bg-card px-3 py-1.5 shadow-xs transition-colors hover:border-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring aria-invalid:border-danger aria-invalid:focus:ring-danger read-only:bg-muted read-only:shadow-none';
/** For controls not yet moved to the components below (react-hook-form fields in the applicant flow). */
export const inputClass = `mt-1 ${control}`;

/** Fields are as wide as their answer, never the whole page: xs 128px, sm 192px, md 352px, lg 512px. */
export type FieldWidth = 'xs' | 'sm' | 'md' | 'lg' | 'full';
const widths: Record<FieldWidth, string> = { xs: 'max-w-32', sm: 'max-w-48', md: 'max-w-[22rem]', lg: 'max-w-lg', full: '' };
interface FieldProps { label: ReactNode; hint?: ReactNode; error?: string; optional?: boolean; width?: FieldWidth; className?: string }
const describedBy = (id: string, hint?: ReactNode, error?: string) => [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;
const fieldId = (id: string | undefined, name: string | undefined) => id ?? `field-${name}`;

/** Label, hint, control and error. The hint stays when an error shows, so the format is still explained. */
export function Field({ id, label, hint, error, optional, width = 'full', className, children }: FieldProps & { id: string; children: ReactNode }) {
  return <div className={cn('grid w-full min-w-0 content-start gap-1.5', widths[width], className)}>
    <label htmlFor={id} className="text-sm font-medium">{label}{optional && <span className="font-normal text-muted-foreground"> (optional)</span>}</label>
    {hint && <p id={`${id}-hint`} className="text-[13px] leading-5 text-muted-foreground">{hint}</p>}
    {children}
    {error && <p id={`${id}-error`} className="flex items-start gap-1.5 text-[13px] leading-5 text-danger"><CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />{error}</p>}
  </div>;
}

export function Input({ id, label, hint, error, optional, width = 'lg', className, ...props }: FieldProps & ComponentProps<'input'>) {
  const key = fieldId(id, props.name);
  return <Field id={key} label={label} hint={hint} error={error} optional={optional} width={width} className={className}>
    <input id={key} aria-invalid={error ? true : undefined} aria-describedby={describedBy(key, hint, error)} className={control} {...props} />
  </Field>;
}
export function Textarea({ id, label, hint, error, optional, width = 'full', className, rows = 4, ...props }: FieldProps & ComponentProps<'textarea'>) {
  const key = fieldId(id, props.name);
  return <Field id={key} label={label} hint={hint} error={error} optional={optional} width={width} className={className}>
    <textarea id={key} rows={rows} aria-invalid={error ? true : undefined} aria-describedby={describedBy(key, hint, error)} className={cn(control, 'min-h-24 resize-y py-2')} {...props} />
  </Field>;
}
export type Option = string | { value: string; label: string };
/** Native select (keyboard behaviour and the phone picker) styled like Input. Option labels are sentence case. */
export function Select({ id, label, hint, error, optional, width = 'md', className, options, placeholder, ...props }: FieldProps & ComponentProps<'select'> & { options: readonly Option[]; placeholder?: string }) {
  const key = fieldId(id, props.name);
  return <Field id={key} label={label} hint={hint} error={error} optional={optional} width={width} className={className}>
    <div className="relative flex items-center">
      <select id={key} aria-invalid={error ? true : undefined} aria-describedby={describedBy(key, hint, error)} className={cn(control, 'cursor-pointer appearance-none pr-9')} {...props}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map(option => typeof option === 'string' ? <option key={option} value={option}>{option}</option> : <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-2.5 size-4 text-muted-foreground" />
    </div>
  </Field>;
}

// Checkbox and radio boxes are styled once in globals.css, so plain inputs in older forms match these components.

/** A yes/no choice or a first-person confirmation (never pre-checked). The whole label is clickable. */
export function Checkbox({ label, description, error, className, ...props }: { label: ReactNode; description?: ReactNode; error?: boolean } & Omit<ComponentProps<'input'>, 'type'>) {
  return <label className={cn('flex items-start gap-3 text-sm', props.disabled && 'cursor-not-allowed opacity-65', className)}>
    <input type="checkbox" aria-invalid={error || undefined} {...props} />
    <span className="min-w-0 leading-6">{label}{description && <span className="block text-[13px] leading-5 text-muted-foreground">{description}</span>}</span>
  </label>;
}
export interface RadioOption { value: string; label: string; description?: string; disabled?: boolean }
/** One choice from 2–5 visible options; `cards` gives each option a tile for a sentence of explanation. */
export function RadioGroup({ name, label, hint, options, value, defaultValue, onChange, cards = false, className }: {
  name: string; label: string; hint?: string; options: RadioOption[]; value?: string; defaultValue?: string; onChange?: (value: string) => void; cards?: boolean; className?: string;
}) {
  return <fieldset className={cn('grid min-w-0 gap-2', className)} aria-describedby={hint ? `${name}-hint` : undefined}>
    <legend className="mb-1 text-sm font-medium">{label}</legend>
    {hint && <p id={`${name}-hint`} className="text-[13px] leading-5 text-muted-foreground">{hint}</p>}
    <div className={cn('grid', cards ? 'gap-2' : 'gap-3')}>
      {options.map(option => <label key={option.value} className={cn('flex items-start gap-3 text-sm', cards && 'rounded-md border border-border p-3 has-checked:border-primary has-checked:bg-brand-subtle', option.disabled && 'cursor-not-allowed opacity-65')}>
        <input type="radio" name={name} value={option.value} disabled={option.disabled}
          {...(value !== undefined ? { checked: value === option.value, onChange: () => onChange?.(option.value) } : { defaultChecked: defaultValue === option.value })} />
        <span className="min-w-0 leading-6"><span className="font-medium">{option.label}</span>{option.description && <span className="block text-[13px] leading-5 text-muted-foreground">{option.description}</span>}</span>
      </label>)}
    </div>
  </fieldset>;
}
