import { Transform, Type } from 'class-transformer';
import { IsDefined, IsEmail, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import { INTERNATIONAL_PHONE_PATTERN } from '../onboarding/application-requirements';
import { VERIFICATION_CODE_PATTERN } from '../onboarding/verification-code';
import { LICENSE_TYPES, type LicenseType, US_STATES } from './safety.entity';
const text = () => Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value);
const upper = () => Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toUpperCase() : value);
// Drafts may leave any answer empty; a format is checked only once something is entered. Submission checks completeness.
const filled = (_object: unknown, value: unknown) => value !== undefined && value !== null && value !== '';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PHONE = { message: 'Enter a phone number with 7 to 15 digits.' };

export class BeginDriverDto {
 @Matches(/^[a-f0-9]{64}$/, { message: 'This link is incomplete. Open the full link from Safety.' }) token!: string;
 @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toLowerCase() : value) @IsEmail({}, { message: 'Enter a valid email address.' }) @MaxLength(254) email!: string;
}
export class VerifyDriverDto {
 @IsUUID() challengeId!: string;
 @Matches(VERIFICATION_CODE_PATTERN, { message: 'Enter the 8-digit code from the email.' }) code!: string;
}
/** The driver's answers. Strings only (empty means not answered yet); the SSN travels separately and is never echoed back. */
export class DriverFieldsDto {
 @text() @IsOptional() @IsString() @MaxLength(100) legalFirstName?: string;
 @text() @IsOptional() @IsString() @MaxLength(100) legalMiddleName?: string;
 @text() @IsOptional() @IsString() @MaxLength(100) legalLastName?: string;
 @IsOptional() @IsString() @ValidateIf(filled) @Matches(DATE, { message: 'Enter the date of birth as a full date.' }) dateOfBirth?: string;
 @text() @IsOptional() @IsString() @MaxLength(40) @ValidateIf(filled) @Matches(INTERNATIONAL_PHONE_PATTERN, PHONE) phone?: string;
 @text() @IsOptional() @IsString() @MaxLength(200) addressLine1?: string;
 @text() @IsOptional() @IsString() @MaxLength(200) addressLine2?: string;
 @text() @IsOptional() @IsString() @MaxLength(100) city?: string;
 @upper() @IsOptional() @IsString() @ValidateIf(filled) @IsIn(US_STATES, { message: 'Choose a US state.' }) state?: string;
 @text() @IsOptional() @IsString() @ValidateIf(filled) @Matches(/^\d{5}(-\d{4})?$/, { message: 'Enter a 5-digit ZIP code.' }) zip?: string;
 @text() @IsOptional() @IsString() @MaxLength(200) emergencyName?: string;
 @text() @IsOptional() @IsString() @MaxLength(50) emergencyRelationship?: string;
 @text() @IsOptional() @IsString() @MaxLength(40) @ValidateIf(filled) @Matches(INTERNATIONAL_PHONE_PATTERN, PHONE) emergencyPhone?: string;
 @upper() @IsOptional() @IsString() @ValidateIf(filled) @Matches(/^[A-Z0-9][A-Z0-9 -]{0,19}$/, { message: 'Enter the license number as printed (letters and digits).' }) licenseNumber?: string;
 @upper() @IsOptional() @IsString() @ValidateIf(filled) @IsIn(US_STATES, { message: 'Choose the state that issued the license.' }) licenseState?: string;
 @IsOptional() @IsString() @ValidateIf(filled) @IsIn(LICENSE_TYPES) licenseClass?: LicenseType | '';
 @IsOptional() @IsString() @ValidateIf(filled) @Matches(DATE, { message: 'Enter the license expiration as a full date.' }) licenseExpiresOn?: string;
}
/** Saves a draft or submits. `ssn` replaces the stored SSN when sent; omit it to keep the one already saved. */
export class SaveDriverApplicationDto {
 @IsInt() @Min(1) version!: number;
 @IsDefined() @IsObject() @ValidateNested() @Type(() => DriverFieldsDto) fields!: DriverFieldsDto;
 @IsOptional() @IsString() @MaxLength(20) ssn?: string;
}
export class DriverVersionDto {
 @IsInt() @Min(1) version!: number;
}
