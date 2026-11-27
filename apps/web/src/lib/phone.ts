/**
 * A phone number as pages show it: a US number (10 digits, or 11 starting with 1) as (202) 555-0201, so numbers typed
 * "+15555550101", "202 555 0201" or "+1 469 555 7345" read the same; anything else as it was typed. Display only: what's
 * stored, searched and dialled is unchanged.
 */
export function phoneLabel(value: string): string;
export function phoneLabel(value: string | null | undefined): string | null;
export function phoneLabel(value: string | null | undefined) {
  if (!value) return value ?? null;
  const digits = value.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  return digits.length === 10 && !/^\s*\+(?!1)/.test(value) ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : value;
}
