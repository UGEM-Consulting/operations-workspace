/**
 * The id that ties a field's label, hint and error to its control. An explicit id wins (the applicant form routes errors
 * to `field-<name>`); otherwise each field gets its own, from React's useId, so two fields without an id or a name (a
 * page field and one in a dialog over it) never share one and a label never points at the wrong box.
 */
export function fieldIdFor(id: string | undefined, name: string | undefined, generated: string): string {
  if (id) return id;
  const unique = generated.replace(/[^A-Za-z0-9_-]/g, '');
  return name ? `field-${name}-${unique}` : `field-${unique}`;
}
