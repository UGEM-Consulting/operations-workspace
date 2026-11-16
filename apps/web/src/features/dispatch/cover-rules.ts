// Drivers while their dispatcher is away (section 34): which dispatchers may cover which drivers. The API checks it again.
export interface CoverDriver { id: string; name: string; truck: string | null; mcId: string; mc: string; coverId: string | null }
export interface CoverDispatcher { id: string; name: string; mcId: string; team: string | null }
export interface CoverOptions { drivers: CoverDriver[]; dispatchers: CoverDispatcher[] }

/** Who may cover one driver: a dispatcher under the driver's MC. */
export const coversFor = (options: CoverOptions, driver: Pick<CoverDriver, 'mcId'>) => options.dispatchers.filter(item => item.mcId === driver.mcId);
/** Who may cover all of them at once ("Everyone covered by"): someone under every driver's MC, so usually one MC's dispatchers. */
export function coverAll(options: CoverOptions) {
  const mcs = new Set(options.drivers.map(item => item.mcId));
  return mcs.size === 1 ? options.dispatchers.filter(item => mcs.has(item.mcId)) : [];
}
/** The choice for every driver: one person for everyone when they all match, else each driver's own (empty until chosen). */
export function startingChoices(options: CoverOptions): Record<string, string> {
  const all = coverAll(options), first = all[0]?.id ?? '';
  return Object.fromEntries(options.drivers.map(driver => [driver.id, driver.coverId ?? (coversFor(options, driver).some(item => item.id === first) ? first : '')]));
}
/** The everyone choice the per-driver choices add up to: one dispatcher, or "different people". */
export function everyoneValue(choices: Record<string, string>) {
  const values = [...new Set(Object.values(choices))];
  return values.length === 1 && values[0] ? values[0] : 'MIXED';
}
