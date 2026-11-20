/**
 * Allowlists for view-only answers (section 39): only the named fields are copied, so whatever a department's own query
 * adds later never reaches a viewer without being named here first.
 */
export function pick<K extends string>(source: Record<string, unknown> | object, keys: readonly K[]): Record<K, unknown> {
  const from = source as Record<string, unknown>, out = {} as Record<K, unknown>;
  for (const key of keys) if (key in from) out[key] = from[key];
  return out;
}
export const pickAll = <K extends string>(rows: readonly (Record<string, unknown> | object)[], keys: readonly K[]) => rows.map(row => pick(row, keys));
