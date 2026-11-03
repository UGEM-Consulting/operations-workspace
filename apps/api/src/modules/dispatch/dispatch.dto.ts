import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import { INTERNATIONAL_PHONE_PATTERN } from '../onboarding/application-requirements';
import { listName } from '../lists/lists.entity';
const name = () => Transform(({ value }: { value: unknown }) => typeof value === 'string' ? listName(value) : value);
const text = () => Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value);
const present = (_object: unknown, value: unknown) => value !== undefined;

/** One person from the file or the form. Everything is text here so one bad value reports on its row, not the whole request. */
export class ExistingRowDto {
 @IsInt() @Min(1) row!: number;
 @IsOptional() @IsString() @MaxLength(300) firstName?: string;
 @IsOptional() @IsString() @MaxLength(300) lastName?: string;
 @IsOptional() @IsString() @MaxLength(300) position?: string;
 @IsOptional() @IsString() @MaxLength(300) mc?: string;
 @IsOptional() @IsString() @MaxLength(300) team?: string;
 @IsOptional() @IsString() @MaxLength(300) jobTitle?: string;
 @IsOptional() @IsString() @MaxLength(300) startedOn?: string;
 @IsOptional() @IsString() @MaxLength(300) companyEmail?: string;
 @IsOptional() @IsString() @MaxLength(300) ringCentralNumber?: string;
 @IsOptional() @IsString() @MaxLength(300) personalEmail?: string;
 @IsOptional() @IsString() @MaxLength(300) personalPhone?: string;
 @IsOptional() @IsString() @MaxLength(300) supports?: string;
 // The one-person form picks the dispatcher from a list, so two people with the same name stay apart.
 @IsOptional() @IsUUID() supportsMemberId?: string;
 @IsOptional() @IsString() @MaxLength(300) ndaSignedOn?: string;
 @IsOptional() @IsString() @MaxLength(300) sopSignedOn?: string;
 @IsOptional() @IsBoolean() differentPerson?: boolean;
}
export class ExistingRowsDto {
 @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => ExistingRowDto) rows!: ExistingRowDto[];
 // The file's name for the history, when there was one. The file itself is never sent or kept.
 @IsOptional() @IsString() @MaxLength(200) sourceName?: string;
}
export class CatchUpLinksDto {
 @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsUUID(undefined, { each: true }) memberIds!: string[];
}
const blankOr = (_object: unknown, value: unknown) => value !== undefined && value !== '';
/** Send only what changed; '' clears a value. */
export class UpdateExistingDto {
 @IsInt() @Min(1) version!: number;
 @text() @ValidateIf(blankOr) @IsEmail() @MaxLength(254) companyEmail?: string;
 @text() @ValidateIf(blankOr) @IsString() @Matches(INTERNATIONAL_PHONE_PATTERN) @MaxLength(40) ringCentralNumber?: string;
 @text() @ValidateIf(blankOr) @IsEmail() @MaxLength(254) personalEmail?: string;
 @text() @ValidateIf(blankOr) @IsString() @Matches(INTERNATIONAL_PHONE_PATTERN) @MaxLength(40) personalPhone?: string;
 @text() @ValidateIf(blankOr) @Matches(/^\d{4}-\d{2}-\d{2}$/) ndaSignedOn?: string;
 @text() @ValidateIf(blankOr) @Matches(/^\d{4}-\d{2}-\d{2}$/) sopSignedOn?: string;
}
export class StatusQueryDto {
 @IsOptional() @IsIn(['ONBOARDING', 'ACTIVE', 'ARCHIVED', 'LEFT', 'ALL']) status?: 'ONBOARDING' | 'ACTIVE' | 'ARCHIVED' | 'LEFT' | 'ALL';
}
export class CreateTeamDto {
 @name() @IsString() @MinLength(1, { message: 'Enter a team name.' }) @MaxLength(100) name!: string;
 @IsUUID() mcId!: string;
}
/** Send only what changed. leadMemberId null clears the lead; `archived` archives or restores. */
export class UpdateTeamDto {
 @IsInt() @Min(1) version!: number;
 @name() @ValidateIf(present) @IsString() @MinLength(1, { message: 'Enter a team name.' }) @MaxLength(100) name?: string;
 @ValidateIf(present) @IsUUID() mcId?: string;
 @ValidateIf((_object: unknown, value: unknown) => value !== undefined && value !== null) @IsUUID() leadMemberId?: string | null;
 @IsOptional() @IsBoolean() archived?: boolean;
}
/** A move closes the current MC and team on startedAt and opens the new one. mcId null means Independent (no team). */
export class MoveMemberDto {
 @IsInt() @Min(1) version!: number;
 @ValidateIf((_object: unknown, value: unknown) => value !== null) @IsUUID() mcId!: string | null;
 @ValidateIf((_object: unknown, value: unknown) => value !== null && value !== undefined) @IsUUID() teamId?: string | null;
 @IsDateString({ strict: true }) startedAt!: string;
 @text() @IsString() @MinLength(1, { message: 'Say why the dispatcher is moving.' }) @MaxLength(500) reason!: string;
}
export class ReassignSupportDto {
 @IsInt() @Min(1) version!: number;
 @IsUUID() dispatcherId!: string;
 @IsDateString({ strict: true }) startedAt!: string;
 @text() @IsString() @MinLength(1, { message: 'Say why the support is changing dispatcher.' }) @MaxLength(500) reason!: string;
}
/** Notice for a future last day: a new date, and why it changed. */
export class ChangeLastDayDto {
 @IsInt() @Min(1) version!: number;
 @IsDateString({ strict: true }) lastDay!: string;
 @text() @IsString() @MinLength(1, { message: 'Say why the last day changed.' }) @MaxLength(500) reason!: string;
}
/** Cancelling a notice, or removing access before the last day: a reason for the history. */
export class NoticeActionDto {
 @IsInt() @Min(1) version!: number;
 @text() @IsString() @MinLength(1, { message: 'Give a reason.' }) @MaxLength(500) reason!: string;
}
export class LeaveMemberDto {
 @IsInt() @Min(1) version!: number;
 @IsDateString({ strict: true }) leftAt!: string;
 @text() @IsString() @MinLength(1, { message: 'Say why the dispatcher left.' }) @MaxLength(500) reason!: string;
 // What IT does with their company email: forward new mail to the manager marking them as left for 30 days, or just
 // suspend it. An older page sends nothing, which suspends.
 @IsOptional() @IsIn(['FORWARD', 'SUSPEND']) emailAfter?: 'FORWARD' | 'SUSPEND';
}
export class UpdateMemberDto {
 @IsInt() @Min(1) version!: number;
 @ValidateIf((_object: unknown, value: unknown) => value !== null && value !== undefined) @IsUUID() jobTitleId?: string | null;
}
/** An extra email or phone number. Phones use the same structural rule as applicant phones; emails are lowercased. */
export class AddContactDto {
 @IsIn(['EMAIL', 'PHONE']) kind!: 'EMAIL' | 'PHONE';
 @text() @IsString() @MaxLength(254)
 @ValidateIf((object: AddContactDto) => object.kind === 'EMAIL') @IsEmail({}, { message: 'Enter a valid email address.' })
 value!: string;
 @text() @IsOptional() @IsString() @MaxLength(50) label?: string;
}
export const validPhone = (value: string) => value.length <= 40 && INTERNATIONAL_PHONE_PATTERN.test(value);
export class CreatePromotionDto {
 @IsUUID() supportId!: string;
 @text() @IsString() @MinLength(1, { message: 'Say why this support is ready to be a dispatcher.' }) @MaxLength(1000) reason!: string;
}
export class PromotionQueryDto {
 @IsOptional() @IsIn(['PENDING', 'APPROVED', 'DECLINED', 'CANCELLED', 'ALL']) status?: 'PENDING' | 'APPROVED' | 'DECLINED' | 'CANCELLED' | 'ALL';
}
/** Approving sets where they will work: mcId null means Independent (no team). Declining needs a note. */
export class DecidePromotionDto {
 @IsInt() @Min(1) version!: number;
 @IsIn(['APPROVE', 'DECLINE']) decision!: 'APPROVE' | 'DECLINE';
 @text() @IsOptional() @IsString() @MaxLength(1000) note?: string;
 @ValidateIf((_object: unknown, value: unknown) => value !== null && value !== undefined) @IsUUID() mcId?: string | null;
 @ValidateIf((_object: unknown, value: unknown) => value !== null && value !== undefined) @IsUUID() teamId?: string | null;
 @IsOptional() @IsUUID() jobTitleId?: string;
}
/**
 * A cleared driver's MC and dispatcher from a date (YYYY-MM-DD), with an optional truck. A change closes the current
 * assignment on that date and needs a reason.
 */
export class AssignDriverDto {
 @IsInt() @Min(1) version!: number;
 @IsUUID() mcId!: string;
 @IsUUID() memberId!: string;
 @IsDateString({ strict: true }) startsOn!: string;
 @text() @IsOptional() @IsString() @MaxLength(40) truck?: string;
 @text() @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
