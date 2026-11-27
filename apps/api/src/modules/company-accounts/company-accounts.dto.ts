import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, ValidateIf } from 'class-validator';
import { INTERNATIONAL_PHONE_PATTERN } from '../onboarding/application-requirements';
import { EMAIL_ACTIONS, type EmailAction } from '../it/it.entity';
import { ACCOUNT_POSITIONS, type AccountPosition } from './company-accounts.entity';
import { listName } from '../lists/lists.entity';
import { EXTENSION } from '../dispatch/account-details';
const name = () => Transform(({ value }: { value: unknown }) => typeof value === 'string' ? listName(value) : value);
const email = () => Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toLowerCase() : value);
const text = () => Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value);
const filled = (_object: unknown, value: unknown) => value !== undefined && value !== '';
const NAME = /^[A-Za-z][A-Za-z .'-]*$/;

/** An account at another of our companies (an MC, archived is fine) or another company's name. Email or number, or both. */
export class AddCompanyAccountDto {
 @IsUUID() memberId!: string;
 @IsOptional() @ValidateIf(filled) @IsIn(ACCOUNT_POSITIONS) position?: AccountPosition | '';
 @ValidateIf((dto: AddCompanyAccountDto) => !dto.companyName) @IsUUID() mcId?: string;
 @ValidateIf((dto: AddCompanyAccountDto) => !dto.mcId) @name() @IsString() @MaxLength(100) companyName?: string;
 @IsOptional() @name() @ValidateIf(filled) @IsString() @MaxLength(100) @Matches(NAME, { message: 'Names use Latin letters only.' }) nameUsed?: string;
 @IsOptional() @email() @ValidateIf(filled) @IsEmail({}, { message: 'Enter the company email.' }) @MaxLength(254) companyEmail?: string;
 @IsOptional() @text() @ValidateIf(filled) @Matches(INTERNATIONAL_PHONE_PATTERN, { message: 'The RingCentral number should have 7 to 15 digits.' }) @MaxLength(40) ringCentralNumber?: string;
 @IsOptional() @text() @ValidateIf(filled) @Matches(EXTENSION, { message: 'The extension should be digits, up to 6.' }) ringCentralExtension?: string;
 @IsOptional() @IsIn(['ACTIVE', 'KEPT_FOR_LOAD_BOARDS', 'CLOSED']) status?: 'ACTIVE' | 'KEPT_FOR_LOAD_BOARDS' | 'CLOSED';
 // For an account recorded as already closed: the day it closed.
 @ValidateIf((dto: AddCompanyAccountDto) => dto.status === 'CLOSED') @IsDateString({ strict: true }) @Matches(/^\d{4}-\d{2}-\d{2}$/) closedOn?: string;
 // What staff should know about the account (section 36). Never passwords.
 @IsOptional() @text() @IsString() @MaxLength(500) note?: string;
 // An email or number that was someone's who left (section 44): IT confirmed it's theirs now. Sent only after the API asked.
 @IsOptional() @IsBoolean() previousOwnerConfirmed?: boolean;
}
/** Only what changed; '' clears a field. Closing it here records that it's closed (Ask IT to close it is a separate request). */
export class UpdateCompanyAccountDto {
 @IsInt() @Min(1) version!: number;
 // Omitted keeps it; '' clears it.
 @IsOptional() @ValidateIf(filled) @IsIn(ACCOUNT_POSITIONS) position?: AccountPosition | '';
 @IsOptional() @name() @ValidateIf(filled) @IsString() @MaxLength(100) @Matches(NAME, { message: 'Names use Latin letters only.' }) nameUsed?: string;
 @IsOptional() @email() @ValidateIf(filled) @IsEmail({}, { message: 'Enter the company email.' }) @MaxLength(254) companyEmail?: string;
 @IsOptional() @text() @ValidateIf(filled) @Matches(INTERNATIONAL_PHONE_PATTERN, { message: 'The RingCentral number should have 7 to 15 digits.' }) @MaxLength(40) ringCentralNumber?: string;
 @IsOptional() @text() @ValidateIf(filled) @Matches(EXTENSION, { message: 'The extension should be digits, up to 6.' }) ringCentralExtension?: string;
 @IsOptional() @IsIn(['ACTIVE', 'KEPT_FOR_LOAD_BOARDS', 'CLOSED']) status?: 'ACTIVE' | 'KEPT_FOR_LOAD_BOARDS' | 'CLOSED';
 @ValidateIf((dto: UpdateCompanyAccountDto) => dto.status === 'CLOSED') @IsDateString({ strict: true }) @Matches(/^\d{4}-\d{2}-\d{2}$/) closedOn?: string;
 // Omitted keeps the note; '' clears it.
 @IsOptional() @text() @IsString() @MaxLength(500) note?: string;
 // An email or number that was someone's who left (section 44): IT confirmed it's theirs now. Sent only after the API asked.
 @IsOptional() @IsBoolean() previousOwnerConfirmed?: boolean;
}
/** Ask IT to close an account (CloseCompanyAccountScreen): what happens to the email and new email, and a note (never passwords). */
export class CloseCompanyAccountDto {
 @IsInt() @Min(1) version!: number;
 @IsIn(['FORWARD', 'SUSPEND']) emailAfter!: 'FORWARD' | 'SUSPEND';
 // Archive, suspend or delete (section 40). An older page sends nothing, which suspends it.
 @IsOptional() @IsIn(EMAIL_ACTIONS) emailAction?: EmailAction;
 @IsOptional() @text() @IsString() @MaxLength(500) note?: string;
}
/** A move's new accounts as IT records them; '' clears one. */
export class AccountContactDto {
 @IsInt() @Min(0) version!: number;
 @IsOptional() @email() @ValidateIf(filled) @IsEmail({}, { message: 'Enter the company email.' }) @MaxLength(254) companyEmail?: string;
 @IsOptional() @text() @ValidateIf(filled) @Matches(INTERNATIONAL_PHONE_PATTERN, { message: 'The RingCentral number should have 7 to 15 digits.' }) @MaxLength(40) ringCentralNumber?: string;
 @IsOptional() @text() @ValidateIf(filled) @Matches(EXTENSION, { message: 'The extension should be digits, up to 6.' }) ringCentralExtension?: string;
}
