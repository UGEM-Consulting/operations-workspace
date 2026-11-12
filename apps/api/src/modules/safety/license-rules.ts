import type { EntityManager } from 'typeorm';
import type { DriverApplicationFields, LicenseType } from './safety.entity';

/**
 * What a driver's license brings with it (section 39, ClearanceCdlScreen and ClearancePickupScreen). Semi trucks need a
 * CDL; pickups with a trailer (26,000 lb) are driven on a regular DL. Both are commercial vehicles, so the driver
 * qualification rules apply to both, but only CDL drivers are under DOT drug and alcohol testing and the Clearinghouse
 * (Part 382). A PSP report is pulled for CDL drivers and anyone who once held a CDL. A valid CDL stands in for the road
 * test (391.33); a regular license never does.
 */
export interface LicenseRules { cdl: boolean; clearinghouse: boolean; psp: boolean; dotTesting: boolean; roadTestAccepted: boolean }
export function licenseRules(licenseType: LicenseType | null | undefined, everHeldCdl?: string | null): LicenseRules {
 const cdl = !!licenseType && licenseType !== 'DL';
 return { cdl, clearinghouse: cdl, psp: cdl || everHeldCdl === 'YES', dotTesting: cdl, roadTestAccepted: cdl };
}
/** The class the driver gave in their application, else the one Safety recorded on the lead. */
export const licenseOf = (driver: { licenseType: LicenseType | null }, fields?: DriverApplicationFields | null) => fields?.licenseClass || driver.licenseType;
export const rulesFor = (driver: { licenseType: LicenseType | null }, fields?: DriverApplicationFields | null) => licenseRules(licenseOf(driver, fields), fields?.everHeldCdl);

export async function driverLicenseRules(em: EntityManager, driverId: string): Promise<LicenseRules> {
 const [row]: { licenseType: LicenseType | null; fields: DriverApplicationFields | null }[] = await em.query(`SELECT d."licenseType", a.fields
  FROM drivers d LEFT JOIN driver_applications a ON a."driverId" = d.id WHERE d.id = $1`, [driverId]);
 return row ? rulesFor(row, row.fields) : licenseRules(null);
}
