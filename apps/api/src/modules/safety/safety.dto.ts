import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { INTERNATIONAL_PHONE_PATTERN } from '../onboarding/application-requirements';
import { listName } from '../lists/lists.entity';
import { DRIVER_TYPES, type DriverType, LICENSE_TYPES, type LicenseType, US_STATES } from './safety.entity';
const name = () => Transform(({ value }: { value: unknown }) => typeof value === 'string' ? listName(value) : value);
const text = () => Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value);
const lower = () => Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toLowerCase() : value);
const upper = () => Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toUpperCase() : value);
const present = (_object: unknown, value: unknown) => value !== undefined;
// Optional fields: null (or omitted on create) means not known; on update, omitted keeps the current value.
const given = (_object: unknown, value: unknown) => value !== undefined && value !== null;
const PHONE = { message: 'Enter a phone number with 7 to 15 digits.' };

export class DriverQueryDto {
 @IsOptional() @IsIn(['OPEN', 'CLOSED', 'ALL']) status?: 'OPEN' | 'CLOSED' | 'ALL';
}
/** A new lead. The Safety lead defaults to the person adding it when they are a Safety lead or manager. */
export class CreateDriverDto {
 @name() @IsString() @MinLength(1, { message: 'Enter a first name.' }) @MaxLength(100) firstName!: string;
 @name() @IsString() @MinLength(1, { message: 'Enter a last name.' }) @MaxLength(100) lastName!: string;
 @text() @IsString() @MaxLength(40) @Matches(INTERNATIONAL_PHONE_PATTERN, PHONE) phone!: string;
 @lower() @ValidateIf(given) @IsEmail({}, { message: 'Enter a valid email address.' }) @MaxLength(254) email?: string | null;
 @IsIn(DRIVER_TYPES) driverType!: DriverType;
 @ValidateIf(given) @IsIn(LICENSE_TYPES) licenseType?: LicenseType | null;
 @upper() @ValidateIf(given) @IsIn(US_STATES, { message: 'Choose a US state.' }) licenseState?: string | null;
 @ValidateIf(given) @IsInt() @Min(0) @Max(60) experienceYears?: number | null;
 @text() @ValidateIf(given) @IsString() @MaxLength(100) source?: string | null;
 @text() @ValidateIf(given) @IsString() @MaxLength(2000) notes?: string | null;
 @ValidateIf(given) @IsUUID() safetyLeadId?: string | null;
}
/** Send only what changed; null clears an optional field. */
export class UpdateDriverDto {
 @IsInt() @Min(1) version!: number;
 @name() @ValidateIf(present) @IsString() @MinLength(1, { message: 'Enter a first name.' }) @MaxLength(100) firstName?: string;
 @name() @ValidateIf(present) @IsString() @MinLength(1, { message: 'Enter a last name.' }) @MaxLength(100) lastName?: string;
 @text() @ValidateIf(present) @IsString() @MaxLength(40) @Matches(INTERNATIONAL_PHONE_PATTERN, PHONE) phone?: string;
 @lower() @ValidateIf(given) @IsEmail({}, { message: 'Enter a valid email address.' }) @MaxLength(254) email?: string | null;
 @ValidateIf(present) @IsIn(DRIVER_TYPES) driverType?: DriverType;
 @ValidateIf(given) @IsIn(LICENSE_TYPES) licenseType?: LicenseType | null;
 @upper() @ValidateIf(given) @IsIn(US_STATES, { message: 'Choose a US state.' }) licenseState?: string | null;
 @ValidateIf(given) @IsInt() @Min(0) @Max(60) experienceYears?: number | null;
 @text() @ValidateIf(given) @IsString() @MaxLength(100) source?: string | null;
 @text() @ValidateIf(given) @IsString() @MaxLength(2000) notes?: string | null;
 @ValidateIf(given) @IsUUID() safetyLeadId?: string | null;
}
export class WithdrawDriverDto {
 @IsInt() @Min(1) version!: number;
 @text() @IsString() @MinLength(1, { message: 'Say why the driver is withdrawn.' }) @MaxLength(500) reason!: string;
}
export class ReopenDriverDto {
 @IsInt() @Min(1) version!: number;
}
/** The first owner needs no reason; changing owner does. */
export class AssignOwnerDto {
 @IsInt() @Min(1) version!: number;
 @IsUUID() ownerId!: string;
 @text() @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
