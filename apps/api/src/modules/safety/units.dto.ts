import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import { filled, text } from './dto-helpers';
import { NoSsn } from './pii';
import { US_STATES } from './safety.entity';
import { ScanUploadDto } from './scan.dto';
import { INTERNATIONAL_PHONE_PATTERN } from '../onboarding/application-requirements';

const upper = () => Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.replace(/\s+/g, '').toUpperCase() : value);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const date = (message: string) => [IsOptional(), IsString(), ValidateIf(filled), IsDateString({ strict: true }, { message: 'Enter a real date.' }), Matches(DATE, { message })];
const apply = (decorators: PropertyDecorator[]): PropertyDecorator => (target, key) => decorators.forEach(decorator => decorator(target, key));
export const UNIT_KINDS = ['SEMI', 'PICKUP', 'TRAILER'] as const;
export type UnitKind = typeof UNIT_KINDS[number];
export const PERMIT_KINDS = ['NY_HUT', 'KYU', 'NM', 'OR', 'IFTA'] as const;
export type PermitKind = typeof PERMIT_KINDS[number];
/** The permits each type carries (Safety's answers, 2026-11-10): every one for a semi truck, New Mexico for a pickup. */
export const PERMITS_FOR: Record<UnitKind, readonly PermitKind[]> = { SEMI: PERMIT_KINDS, PICKUP: ['NM'], TRAILER: [] };
export const UNIT_FILE_KINDS = ['REGISTRATION', 'INSPECTION', 'PERMITS', 'OTHER'] as const;

/**
 * A truck or trailer. The owner is exactly one of a truck owner (ownerId), an owner-operator (driverId) or the company
 * (company, trailers only). Dates are optional: a unit can be added before its papers are in hand.
 */
export class UnitDto {
 @IsOptional() @IsInt() @Min(1) version?: number;
 @text() @IsString() @MinLength(1, { message: 'Enter the unit number.' }) @MaxLength(20) number!: string;
 @IsIn(UNIT_KINDS) kind!: UnitKind;
 @IsOptional() @IsUUID() ownerId?: string;
 @IsOptional() @IsUUID() driverId?: string;
 @IsOptional() @IsBoolean() company?: boolean;
 @upper() @IsString() @Matches(/^[A-HJ-NPR-Z0-9]{17}$/, { message: 'A VIN has 17 letters and numbers, never I, O or Q.' }) vin!: string;
 @IsInt() @Min(1980) @Max(2100) year!: number;
 @text() @IsString() @MinLength(1, { message: 'Enter the make and model.' }) @MaxLength(40) make!: string;
 @upper() @IsOptional() @IsString() @ValidateIf(filled) @MaxLength(12) plate?: string;
 @upper() @IsOptional() @IsString() @ValidateIf(filled) @IsIn(US_STATES, { message: 'Choose a state.' }) plateState?: string;
 @text() @IsOptional() @IsString() @MaxLength(60) trailerType?: string;
 @apply(date('Enter the registration expiration as a full date.')) registrationExpiresOn?: string;
 @apply(date('Enter the inspection date as a full date.')) inspectedOn?: string;
 @IsOptional() @IsUUID() responsibleId?: string;
}
export class UnitPermitDto {
 @IsIn(PERMIT_KINDS) kind!: PermitKind;
 @IsString() @IsDateString({ strict: true }, { message: 'Enter a real date.' }) @Matches(DATE, { message: 'Enter the expiration as a full date.' }) expiresOn!: string;
}
/** Update dates: what a person read on the registration, the inspection report and each permit. A missing key keeps the date. */
export class UnitDatesDto {
 @IsInt() @Min(1) version!: number;
 @apply(date('Enter the registration expiration as a full date.')) registrationExpiresOn?: string;
 @apply(date('Enter the inspection date as a full date.')) inspectedOn?: string;
 @IsOptional() @IsArray() @ArrayMaxSize(PERMIT_KINDS.length) @ValidateNested({ each: true }) @Type(() => UnitPermitDto) permits?: UnitPermitDto[];
}
export class UnitStatusDto {
 @IsInt() @Min(1) version!: number;
 @IsIn(['IN_SERVICE', 'OUT_OF_SERVICE', 'ARCHIVED']) status!: 'IN_SERVICE' | 'OUT_OF_SERVICE' | 'ARCHIVED';
}
export class UnitResponsibleDto {
 @IsInt() @Min(1) version!: number;
 @IsUUID() responsibleId!: string;
}
/** An optional copy of a unit's paper (the papers live in DataTruck and the binder): one PDF or photographed pages. */
export class UnitFileDto extends ScanUploadDto {
 @IsInt() @Min(1) version!: number;
 @IsIn(UNIT_FILE_KINDS) kind!: typeof UNIT_FILE_KINDS[number];
}
export const OWNER_CONTRACT_KINDS = ['IC_AGREEMENT', 'EQUIPMENT_LEASE', 'EQUIPMENT_RECEIPT', 'OTHER'] as const;
/** A contract with a truck owner, signed on paper and uploaded (TruckOwnerScreen): its kind, when it was signed, and for a receipt the truck. */
export class OwnerContractDto extends ScanUploadDto {
 @IsInt() @Min(1) version!: number;
 @IsIn(OWNER_CONTRACT_KINDS) kind!: typeof OWNER_CONTRACT_KINDS[number];
 @text() @IsOptional() @IsString() @ValidateIf(filled) @MaxLength(120) @NoSsn() title?: string;
 @IsOptional() @IsUUID() unitId?: string;
 @IsString() @IsDateString({ strict: true }, { message: 'Enter a real date.' }) @Matches(DATE, { message: 'Enter the date it was signed as a full date.' }) signedOn!: string;
}
/** Year-end renewal: the units chosen get the new expiration on every permit their type carries (or the kinds named). */
export class RenewPermitsDto {
 @IsArray() @ArrayMinSize(1, { message: 'Choose at least one unit.' }) @ArrayMaxSize(500) @IsUUID('all', { each: true }) unitIds!: string[];
 @IsString() @IsDateString({ strict: true }, { message: 'Enter a real date.' }) @Matches(DATE, { message: 'Enter the new expiration as a full date.' }) expiresOn!: string;
 @IsOptional() @IsArray() @ArrayMaxSize(PERMIT_KINDS.length) @IsIn(PERMIT_KINDS, { each: true }) kinds?: PermitKind[];
}
/** A truck owner's company and who signs for it. Never pay terms, tax IDs or bank details. */
export class TruckOwnerDto {
 @IsOptional() @IsInt() @Min(1) version?: number;
 @text() @IsString() @MinLength(1, { message: 'Enter the company name.' }) @MaxLength(200) @NoSsn() name!: string;
 @text() @IsOptional() @IsString() @MaxLength(100) @NoSsn() signerName?: string;
 @text() @IsOptional() @IsString() @MaxLength(60) @NoSsn() signerTitle?: string;
 @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toLowerCase() : value) @IsOptional() @ValidateIf(filled) @IsEmail({}, { message: 'Enter a valid email address.' }) @MaxLength(254) email?: string;
 @text() @IsOptional() @IsString() @ValidateIf(filled) @MaxLength(40) @Matches(INTERNATIONAL_PHONE_PATTERN, { message: 'Enter a phone number with 7 to 15 digits.' }) phone?: string;
}
export class OwnerVersionDto { @IsInt() @Min(1) version!: number; }
