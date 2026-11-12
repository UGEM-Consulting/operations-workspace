import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator';
import { ConflictException, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { fileDate } from '../dispatch/existing.service';
import { User } from '../users/user.entity';
import { US_STATES } from './safety.entity';
import { usDay } from './screening-rules';
import type { UnitKind } from './units.dto';
import { insertOwner, insertUnit, lockOperators, UNIT_NUMBER_LOCK } from './units.service';

/** One cell of an imported file: optional text, checked on its row (shared by the units and existing drivers files). */
export const cell = () => (target: object, key: string | symbol) => { IsOptional()(target, key); IsString()(target, key); MaxLength(300)(target, key); };
/** One unit from the file, as text; every value is checked here, row by row, so one bad value reports on its row. */
export class UnitImportRowDto {
 @IsInt() @Min(1) row!: number;
 @cell() number?: string; @cell() type?: string; @cell() trailerType?: string; @cell() year?: string; @cell() make?: string; @cell() vin?: string;
 @cell() plate?: string; @cell() plateState?: string; @cell() owner?: string; @cell() responsible?: string; @cell() registrationExpiresOn?: string; @cell() inspectedOn?: string;
}
export class UnitImportDto {
 @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => UnitImportRowDto) rows!: UnitImportRowDto[];
}

/**
 * The result both import screens share (UnitsCheckRowsScreen, ExistingDriversCheckScreen): each row's status, the problems
 * that keep it out, and the choices that fix every row with the same text. A choice's value goes back in that row's column,
 * so the next check reads it; values starting with @ name a record by id.
 */
export type ImportStatus = 'READY' | 'CHOICE' | 'PROBLEM' | 'ALREADY';
export interface ImportChoice { field: string; text: string; rows: number[]; options: { value: string; label: string }[] }
export interface ImportRow { row: number; name: string; detail: string; status: ImportStatus; problems: string[]; notes: string[] }
export function summary(rows: ImportRow[], choices: ImportChoice[]) {
 const count = (status: ImportStatus) => rows.filter(row => row.status === status).length;
 return { rows, choices, counts: { ready: count('READY'), choice: count('CHOICE'), problem: count('PROBLEM'), already: count('ALREADY') } };
}
export const fold = (value?: string) => (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
/** Collects the rows that share one unread text into a single choice. */
export function addChoice(choices: ImportChoice[], field: string, text: string, row: number, options: () => ImportChoice['options']) {
 const found = choices.find(choice => choice.field === field && fold(choice.text) === fold(text));
 if (found) found.rows.push(row); else choices.push({ field, text: text.trim(), rows: [row], options: options() });
}

const KINDS: Record<string, UnitKind> = { semi: 'SEMI', 'semi truck': 'SEMI', truck: 'SEMI', pickup: 'PICKUP', 'pickup truck': 'PICKUP', trailer: 'TRAILER' };
const KIND_WORDS: Record<UnitKind, string> = { SEMI: 'Semi truck', PICKUP: 'Pickup', TRAILER: 'Trailer' };
type Owner = { ownerId?: string; driverId?: string; company?: true; newOwner?: string };
interface Ready { row: number; number: string; kind: UnitKind; trailerType: string | null; year: number; make: string; vin: string; plate: string | null; plateState: string | null; owner: Owner; responsibleId: string | null; registrationExpiresOn: string | null; inspectedOn: string | null }

/**
 * Units from a file (UnitsCheckRowsScreen): the browser reads the CSV and sends rows as text. check writes nothing; add
 * checks every row again under the unit-number lock and adds only those ready. A VIN already in Units is Already here; a
 * number or VIN twice in the file is a problem on the later row. An owner that matches no truck owner or owner-operator is a
 * choice, which may add them as a new truck owner. Values are never kept in events: ADDED records imported and counts.
 */
@Injectable()
export class UnitsImportService {
 constructor(private readonly db: DataSource) {}

 check(dto: UnitImportDto) { return this.read(this.db.manager, dto.rows).then(({ rows, choices }) => summary(rows, choices)); }

 async add(user: User, dto: UnitImportDto) {
  return this.db.transaction(async em => {
   // Owner-operators named in the file are locked first, with the same rule as adding their truck by hand (who may, and
   // their record's version and history), then the number lock, then every row is checked again.
   const operators = (await this.read(em, dto.rows)).ready.map(unit => unit.owner.driverId);
   await lockOperators(em, user, operators);
   await em.query('SELECT pg_advisory_xact_lock($1)', [UNIT_NUMBER_LOCK]);
   const { rows, ready } = await this.read(em, dto.rows);
   if (ready.some(unit => unit.owner.driverId && !operators.includes(unit.owner.driverId))) throw new ConflictException('The file changed what it names while it was being added. Check it again.');
   const created = new Map<string, string>(), units: { row: number; id: string }[] = [];
   for (const unit of ready) {
    let ownerId = unit.owner.ownerId ?? null;
    if (unit.owner.newOwner) {
     const key = fold(unit.owner.newOwner);
     ownerId = created.get(key) ?? await insertOwner(em, user, { name: unit.owner.newOwner }, true);
     created.set(key, ownerId);
    }
    const id = await insertUnit(em, user, { number: unit.number, kind: unit.kind, ownerId, driverId: unit.owner.driverId ?? null, company: unit.owner.company === true, vin: unit.vin, year: unit.year,
     make: unit.make, plate: unit.plate, plateState: unit.plateState, trailerType: unit.trailerType, registrationExpiresOn: unit.registrationExpiresOn, inspectedOn: unit.inspectedOn, responsibleId: unit.responsibleId }, true);
    units.push({ row: unit.row, id });
   }
   return { added: units.length, units, owners: created.size, left: rows.filter(row => row.status !== 'READY') };
  });
 }

 private async read(em: EntityManager, input: UnitImportRowDto[]) {
  const [owners, operators, staff, current, archived] = await Promise.all([
   em.query(`SELECT id, name FROM truck_owners WHERE "archivedAt" IS NULL ORDER BY "nameKey"`) as Promise<{ id: string; name: string }[]>,
   em.query(`SELECT id, "firstName" || ' ' || "lastName" AS name FROM drivers WHERE "driverType" = 'OWNER_OPERATOR' AND status IN ('APPROVED','CLEARED') ORDER BY lower("lastName"), lower("firstName")`) as Promise<{ id: string; name: string }[]>,
   em.query(`SELECT id, "firstName" || ' ' || "lastName" AS name, "firstName" AS first FROM users WHERE status = 'ACTIVE' AND role::text = 'SAFETY_STAFF' ORDER BY lower("firstName"), lower("lastName")`) as Promise<{ id: string; name: string; first: string }[]>,
   em.query(`SELECT t.unit, t.vin, coalesce(o.name, d."firstName" || ' ' || d."lastName", 'the company') AS owner FROM driver_trucks t LEFT JOIN truck_owners o ON o.id = t."ownerId"
    LEFT JOIN drivers d ON d.id = t."driverId" WHERE t."archivedAt" IS NULL`) as Promise<{ unit: string; vin: string; owner: string }[]>,
   em.query(`SELECT "nameKey" FROM truck_owners WHERE "archivedAt" IS NOT NULL`) as Promise<{ nameKey: string }[]>]);
  const ownerOptions = () => [...owners.map(item => ({ value: `@owner:${item.id}`, label: `${item.name} · truck owner` })), ...operators.map(item => ({ value: `@driver:${item.id}`, label: `${item.name} · owner-operator` }))];
  const staffOptions = () => [...staff.map(item => ({ value: `@${item.id}`, label: item.name })), { value: '@none', label: 'No one yet' }];
  const today = usDay('latest'), rows: ImportRow[] = [], ready: Ready[] = [], choices: ImportChoice[] = [];
  const seenNumbers = new Map<string, number>(), seenVins = new Map<string, number>();
  for (const input_ of input) {
   const value = (key: keyof UnitImportRowDto) => String(input_[key] ?? '').trim();
   const problems: string[] = [], notes: string[] = [];
   let choice = false, already = false;
   // Type: a word it knows, or a choice that names one.
   const typeText = value('type'), kind = KINDS[fold(typeText)] ?? (['SEMI', 'PICKUP', 'TRAILER'].includes(typeText) ? typeText as UnitKind : undefined);
   if (!typeText) problems.push('No type. Write Semi truck, Pickup or Trailer.');
   else if (!kind) { choice = true; addChoice(choices, 'type', typeText, input_.row, () => (['SEMI', 'PICKUP', 'TRAILER'] as const).map(item => ({ value: item, label: KIND_WORDS[item] }))); }
   const number = value('number').replace(/\s+/g, ' ');
   if (!number) problems.push('No unit number.');
   else if (number.length > 20) problems.push('The unit number is longer than 20 characters.');
   const vin = value('vin').replace(/\s+/g, '').toUpperCase();
   if (!vin) problems.push('No VIN.');
   else if (/[IOQ]/.test(vin)) { const letter = vin.match(/[IOQ]/)![0]; problems.push(`VIN “${vin}” has ${letter === 'Q' ? 'a' : 'an'} ${letter}, which a VIN never has.`); }
   else if (!/^[A-Z0-9]{17}$/.test(vin)) problems.push(`VIN “${vin.slice(0, 30)}” isn’t 17 letters and numbers.`);
   const yearText = value('year'), year = Number(yearText);
   if (!/^\d{4}$/.test(yearText) || year < 1980 || year > Number(today.slice(0, 4)) + 1) problems.push(yearText ? `Year “${yearText.slice(0, 20)}” isn’t a model year.` : 'No model year.');
   const make = value('make').replace(/\s+/g, ' ');
   if (!make) problems.push('No make and model.'); else if (make.length > 40) problems.push('The make and model is longer than 40 characters.');
   const plate = value('plate').replace(/\s+/g, '').toUpperCase(), plateState = value('plateState').toUpperCase();
   if ((plate ? 1 : 0) !== (plateState ? 1 : 0)) problems.push('Write the plate and its state together.');
   else if (plate.length > 12) problems.push('The plate is longer than 12 characters.');
   else if (plateState && !(US_STATES as readonly string[]).includes(plateState)) problems.push(`Plate state “${plateState.slice(0, 20)}” isn’t a US state code.`);
   const trailerType = kind === 'TRAILER' ? value('trailerType').replace(/\s+/g, ' ').slice(0, 60) || null : null;
   const dateOf = (key: 'registrationExpiresOn' | 'inspectedOn', what: string) => {
    const text = value(key); if (!text) return null;
    const day = fileDate(text);
    if (!day) problems.push(`${what} “${text.slice(0, 30)}” isn’t a date.`);
    return day;
   };
   const registrationExpiresOn = dateOf('registrationExpiresOn', 'Registration expires'), inspectedOn = dateOf('inspectedOn', 'Inspected on');
   if (inspectedOn && inspectedOn > today) problems.push('The inspection date is in the future.');
   // Owner: Company (trailers), a truck owner or an owner-operator by name, or a choice.
   const ownerText = value('owner'); let owner: Owner | null = null;
   if (!ownerText) problems.push('No owner. Write the truck owner, the owner-operator’s name, or Company for a company trailer.');
   else if (ownerText === '@new') problems.push('Choose an owner.');
   else if (ownerText.startsWith('@owner:')) owner = owners.some(item => item.id === ownerText.slice(7)) ? { ownerId: ownerText.slice(7) } : null;
   else if (ownerText.startsWith('@driver:')) owner = operators.some(item => item.id === ownerText.slice(8)) ? { driverId: ownerText.slice(8) } : null;
   else if (ownerText.startsWith('@new:')) {
    if (archived.some(item => item.nameKey === fold(ownerText.slice(5))) || owners.some(item => fold(item.name) === fold(ownerText.slice(5)))) problems.push(`A truck owner named “${ownerText.slice(5, 65)}” is already on the list or archived. Restore or choose them instead.`);
    else owner = { newOwner: ownerText.slice(5) };
   }
   else if (fold(ownerText) === 'company') owner = { company: true };
   else {
    const byOwner = owners.filter(item => fold(item.name) === fold(ownerText)), byDriver = operators.filter(item => fold(item.name) === fold(ownerText));
    if (byOwner.length + byDriver.length === 1) owner = byOwner[0] ? { ownerId: byOwner[0].id } : { driverId: byDriver[0].id };
    else { choice = true; addChoice(choices, 'owner', ownerText, input_.row, () => [{ value: `@new:${ownerText.trim().replace(/\s+/g, ' ').slice(0, 120)}`, label: `Add “${ownerText.trim().slice(0, 60)}” as a new truck owner` }, ...ownerOptions()]); }
   }
   if (ownerText.startsWith('@') && !owner && !problems.length) problems.push('The owner chosen is no longer on the list. Upload again.');
   if (owner && kind) {
    if (owner.company && kind !== 'TRAILER') problems.push('The company owns trailers only. A truck belongs to a truck owner or an owner-operator.');
   }
   // Responsible Safety Manager: optional; a name or first name that matches one person, else a choice.
   const responsibleText = value('responsible'); let responsibleId: string | null = null;
   if (responsibleText === '@none') responsibleId = null;
   else if (responsibleText.startsWith('@')) { responsibleId = staff.some(item => item.id === responsibleText.slice(1)) ? responsibleText.slice(1) : null; if (!responsibleId) problems.push('The Safety Manager chosen is no longer active. Upload again.'); }
   else if (responsibleText) {
    const full = staff.filter(item => fold(item.name) === fold(responsibleText)), first = staff.filter(item => fold(item.first) === fold(responsibleText));
    const match = full.length === 1 ? full[0] : !full.length && first.length === 1 ? first[0] : null;
    if (match) responsibleId = match.id;
    else { choice = true; addChoice(choices, 'responsible', responsibleText, input_.row, staffOptions); }
   }
   // Already here by VIN; a number used by another unit; repeats in the file.
   const here = vin ? current.find(item => item.vin === vin) : undefined;
   if (here) { already = true; notes.push(`Already in Units with this VIN (unit ${here.unit}, ${here.owner}). This row is left out.`); }
   else {
    const taken = number ? current.find(item => fold(item.unit) === fold(number)) : undefined;
    if (taken) problems.push(`Unit ${number} is already in Units (${taken.owner}). Give this one another number.`);
    if (number && seenNumbers.has(fold(number))) problems.push(`Unit ${number} is also on row ${seenNumbers.get(fold(number))}.`);
    if (vin && seenVins.has(vin)) problems.push(`This VIN is also on row ${seenVins.get(vin)}.`);
   }
   if (number && !seenNumbers.has(fold(number))) seenNumbers.set(fold(number), input_.row);
   if (vin && !seenVins.has(vin)) seenVins.set(vin, input_.row);
   const status: ImportStatus = already ? 'ALREADY' : problems.length ? 'PROBLEM' : choice ? 'CHOICE' : 'READY';
   const ownerName = owner?.company ? 'Company' : owner?.ownerId ? owners.find(item => item.id === owner!.ownerId)?.name : owner?.driverId ? `${operators.find(item => item.id === owner!.driverId)?.name}, owner-operator` : owner?.newOwner ?? (ownerText.startsWith('@') ? '' : ownerText);
   rows.push({ row: input_.row, name: number || 'No number', detail: [kind ? KIND_WORDS[kind] : typeText, ownerName].filter(Boolean).join(' · '), status, problems: already ? notes : problems, notes });
   if (status === 'READY' && kind && owner) ready.push({ row: input_.row, number, kind, trailerType, year, make, vin, plate: plate || null, plateState: plateState || null, owner, responsibleId, registrationExpiresOn, inspectedOn });
  }
  return { rows, ready, choices };
 }
}

