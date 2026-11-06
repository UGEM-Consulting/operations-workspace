import { upper, filled } from './dto-helpers';
import { Transform, Type } from 'class-transformer';
import { applyDecorators } from '@nestjs/common';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBase64, IsBoolean, IsDateString, IsDefined, IsEmail, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import { MAX_PHOTO_BYTES } from '../documents/documents.dto';
import { MAX_SCAN_PAGES } from './scan';
import { INTERNATIONAL_PHONE_PATTERN } from '../onboarding/application-requirements';
import { VERIFICATION_CODE_PATTERN } from '../onboarding/verification-code';
import { LICENSE_TYPES, type LicenseType, US_STATES, WORK_AUTHORIZATION_TYPES, type WorkAuthorizationType } from './safety.entity';
const text = () => Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value);
// Drafts may leave any answer empty; a format is checked only once something is entered. Submission checks completeness.
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
 @IsOptional() @IsString() @ValidateIf(filled) @IsDateString({ strict: true }, { message: 'Enter a real date.' }) @Matches(DATE, { message: 'Enter the date of birth as a full date.' }) dateOfBirth?: string;
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
 @IsOptional() @IsString() @ValidateIf(filled) @IsDateString({ strict: true }, { message: 'Enter a real date.' }) @Matches(DATE, { message: 'Enter the license expiration as a full date.' }) licenseExpiresOn?: string;
}
// Address and work history. Each entry the driver adds is complete (the page's own forms ask for every part); the whole
// history is checked for coverage only at submission (history-rules.ts).
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/, MONTH_MESSAGE = { message: 'Enter a month.' };
const required = (max: number) => applyDecorators(text(), IsString(), MinLength(1, { message: 'Fill in every part.' }), MaxLength(max));
const state = () => applyDecorators(upper(), IsIn(US_STATES, { message: 'Choose a US state.' }));
export class HistoryAddressDto {
 @IsUUID() id!: string;
 @required(200) line1!: string;
 @required(100) city!: string;
 @state() state!: string;
 @text() @Matches(/^\d{5}(-\d{4})?$/, { message: 'Enter a 5-digit ZIP code.' }) zip!: string;
 @Matches(MONTH, MONTH_MESSAGE) fromMonth!: string;
 @Matches(MONTH, MONTH_MESSAGE) toMonth!: string;
}
export class HistoryJobDto {
 @IsUUID() id!: string;
 @required(200) company!: string;
 @required(100) city!: string;
 @state() state!: string;
 @text() @IsString() @MaxLength(40) @Matches(INTERNATIONAL_PHONE_PATTERN, PHONE) phone!: string;
 @required(100) position!: string;
 @Matches(MONTH, MONTH_MESSAGE) fromMonth!: string;
 // null: the driver still works there.
 @ValidateIf((_object: unknown, value: unknown) => value !== null) @Matches(MONTH, MONTH_MESSAGE) toMonth!: string | null;
 @IsIn(['YES', 'NO']) drove!: 'YES' | 'NO';
 @IsIn(['YES', 'NO', 'UNSURE']) fmcsr!: 'YES' | 'NO' | 'UNSURE';
 @IsIn(['YES', 'NO', 'UNSURE']) dotTesting!: 'YES' | 'NO' | 'UNSURE';
 @text() @IsString() @MaxLength(200) reasonLeft!: string;
}
export class HistoryGapDto {
 @Matches(MONTH, MONTH_MESSAGE) from!: string;
 @Matches(MONTH, MONTH_MESSAGE) to!: string;
 @text() @IsString() @MaxLength(500) explanation!: string;
}
export class HistoryAccidentDto {
 @IsUUID() id!: string;
 @Matches(MONTH, MONTH_MESSAGE) month!: string;
 @state() state!: string;
 @required(300) description!: string;
}
export class HistoryTicketDto {
 @IsUUID() id!: string;
 @Matches(MONTH, MONTH_MESSAGE) month!: string;
 @state() state!: string;
 @required(200) violation!: string;
 @IsIn(['CMV', 'OTHER']) vehicle!: 'CMV' | 'OTHER';
}
export class HistoryLicenseDto {
 @IsUUID() id!: string;
 @state() state!: string;
 @upper() @IsString() @Matches(/^[A-Z0-9][A-Z0-9 -]{0,19}$/, { message: 'Enter the license number as printed (letters and digits).' }) number!: string;
 @IsIn(LICENSE_TYPES) licenseClass!: string;
}
const list = (type: () => new () => object, max: number) => applyDecorators(IsOptional(), IsArray(), ArrayMaxSize(max), ValidateNested({ each: true }), Type(type));
const yesNo = () => applyDecorators(IsOptional(), IsIn(['YES', 'NO']));
/** The whole history as the driver's page holds it; a save that sends it replaces the stored one. */
export class DriverHistoryDto {
 @IsOptional() @Matches(MONTH, MONTH_MESSAGE) currentSince?: string;
 @list(() => HistoryAddressDto, 20) addresses?: HistoryAddressDto[];
 @list(() => HistoryJobDto, 40) jobs?: HistoryJobDto[];
 @list(() => HistoryGapDto, 40) gaps?: HistoryGapDto[];
 @IsOptional() @IsBoolean() noEarlierDriving?: boolean;
 @yesNo() accidents?: 'YES' | 'NO';
 @list(() => HistoryAccidentDto, 20) accidentList?: HistoryAccidentDto[];
 @yesNo() tickets?: 'YES' | 'NO';
 @list(() => HistoryTicketDto, 20) ticketList?: HistoryTicketDto[];
 @yesNo() otherLicenses?: 'YES' | 'NO';
 @list(() => HistoryLicenseDto, 5) licenseList?: HistoryLicenseDto[];
 @yesNo() licenseTrouble?: 'YES' | 'NO';
 @text() @IsOptional() @IsString() @MaxLength(500) licenseTroubleNote?: string;
}
/**
 * Saves a draft or submits. `ssn` replaces the stored SSN when sent; omit it to keep the one already saved. `history`,
 * when sent, replaces the stored history; omit it to keep it.
 */
export class SaveDriverApplicationDto {
 @IsInt() @Min(1) version!: number;
 @IsDefined() @IsObject() @ValidateNested() @Type(() => DriverFieldsDto) fields!: DriverFieldsDto;
 @IsOptional() @IsObject() @ValidateNested() @Type(() => DriverHistoryDto) history?: DriverHistoryDto;
 @IsOptional() @IsString() @MaxLength(20) ssn?: string;
}
export class DriverVersionDto {
 @IsInt() @Min(1) version!: number;
}
/** One scanned document: 1 to 4 photographed pages (base64 JPEG). The work-authorization type is the driver's choice. */
export class DriverDocumentDto {
 @IsArray() @ArrayMinSize(1, { message: 'Take a photo of at least one page.' }) @ArrayMaxSize(MAX_SCAN_PAGES, { message: `Scan at most ${MAX_SCAN_PAGES} pages.` })
 @IsString({ each: true }) @IsBase64({}, { each: true }) @MaxLength(Math.ceil(MAX_PHOTO_BYTES / 3) * 4, { each: true }) pages!: string[];
 @IsOptional() @IsIn(WORK_AUTHORIZATION_TYPES) subtype?: WorkAuthorizationType;
}
/**
 * Safety's record of what the document shows, against the version the person saw. Empty strings clear a value. The
 * service requires the expiry of a license or medical card and refuses a number for work authorization.
 */
export class VerifyDocumentDto {
 @IsInt() @Min(1) version!: number;
 @text() @IsOptional() @IsString() @MaxLength(40) number?: string;
 @IsOptional() @IsString() @ValidateIf(filled) @IsDateString({ strict: true }, { message: 'Enter a real date.' }) @Matches(DATE, { message: 'Enter the expiration as a full date.' }) expiresOn?: string;
}
