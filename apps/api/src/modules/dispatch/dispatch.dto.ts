import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, Equals, IsArray, IsBoolean, IsDateString, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import { INTERNATIONAL_PHONE_PATTERN } from '../onboarding/application-requirements';
import { listName } from '../lists/lists.entity';
import { EXTENSION } from './account-details';
import { SUPPORT_TYPES, type SupportType } from './dispatch.entity';
import { SUPPORT_IT_ITEM_KEYS, type SupportItItem } from '../it/it.entity';
import { ScanUploadDto } from '../safety/scan.dto';
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
 @IsOptional() @IsString() @MaxLength(300) telegram?: string;
 @IsOptional() @IsString() @MaxLength(300) ringCentralExtension?: string;
 @IsOptional() @IsString() @MaxLength(300) datEmail?: string;
 @IsOptional() @IsString() @MaxLength(300) truckstopEmail?: string;
 @IsOptional() @IsString() @MaxLength(300) supports?: string;
 // The one-person form picks the dispatcher or team from a list, so two people with the same name stay apart.
 @IsOptional() @IsUUID() supportsMemberId?: string;
 @IsOptional() @IsUUID() supportsTeamId?: string;
 @IsOptional() @IsString() @MaxLength(300) ndaSignedOn?: string;
 @IsOptional() @IsString() @MaxLength(300) sopSignedOn?: string;
 @IsOptional() @IsBoolean() differentPerson?: boolean;
 // People who left and other names (section 33): Active or Left, the last day and why, legal names and other names separated by ;.
 @IsOptional() @IsString() @MaxLength(300) status?: string;
 @IsOptional() @IsString() @MaxLength(300) leftOn?: string;
 @IsOptional() @IsString() @MaxLength(1000) leftReason?: string;
 @IsOptional() @IsString() @MaxLength(300) legalFirstName?: string;
 @IsOptional() @IsString() @MaxLength(300) legalLastName?: string;
 @IsOptional() @IsString() @MaxLength(1500) otherNames?: string;
 // Someone added as Left whose accounts may still be open: IT gets a removal checklist from what the row records.
 @IsOptional() @IsBoolean() askIt?: boolean;
 // A row that matches someone already recorded: fill only what their record is missing, or (for someone who left) add them again as the same person.
 @IsOptional() @IsIn(['FILL', 'CAME_BACK']) alreadyAction?: 'FILL' | 'CAME_BACK';
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
 @text() @ValidateIf(blankOr) @IsString() @MaxLength(100) telegram?: string;
 @text() @ValidateIf(blankOr) @Matches(EXTENSION, { message: 'The extension should be digits, up to 6.' }) ringCentralExtension?: string;
 @text() @ValidateIf(blankOr) @IsEmail({}, { message: 'A load board sign-in takes the sign-in email only, never a password.' }) @MaxLength(254) datEmail?: string;
 @text() @ValidateIf(blankOr) @IsEmail({}, { message: 'A load board sign-in takes the sign-in email only, never a password.' }) @MaxLength(254) truckstopEmail?: string;
 @text() @ValidateIf(blankOr) @Matches(/^\d{4}-\d{2}-\d{2}$/) ndaSignedOn?: string;
 @text() @ValidateIf(blankOr) @Matches(/^\d{4}-\d{2}-\d{2}$/) sopSignedOn?: string;
}
/** Dispatch › Dispatchers' filters (the Dispatchers table group in the Design System). teamId NONE means placed under an MC with no team (Independent). */
export class MemberFilters {
 @IsOptional() @text() @IsString() @MaxLength(100) search?: string;
 @IsOptional() @IsUUID() mcId?: string;
 @IsOptional() @ValidateIf((_, value) => value !== 'NONE') @IsUUID() teamId?: string;
 @IsOptional() @IsUUID() leadId?: string;
 @IsOptional() @IsUUID() jobTitleId?: string;
 @IsOptional() @IsIn(['DISPATCHER', 'SUPPORT', 'UPDATER']) position?: 'DISPATCHER' | 'SUPPORT' | 'UPDATER';
 @IsOptional() @IsIn(['ONBOARDED', 'ADDED']) source?: 'ONBOARDED' | 'ADDED';
 @IsOptional() @IsIn(['WITH', 'WITHOUT']) drivers?: 'WITH' | 'WITHOUT';
}
/** A page of Dispatch › Dispatchers. A request with none of page, filters or sort gets the whole list as before, for an older web. */
export class MemberListQueryDto extends MemberFilters {
 @IsOptional() @IsIn(['ONBOARDING', 'ACTIVE', 'ON_LEAVE', 'LEAVING', 'LEFT', 'MISSING', 'ALL', 'ARCHIVED']) status?: 'ONBOARDING' | 'ACTIVE' | 'ON_LEAVE' | 'LEAVING' | 'LEFT' | 'MISSING' | 'ALL';
 @IsOptional() @IsIn(['name', 'mc', 'team', 'lead', 'drivers', 'since', 'status']) sort?: 'name' | 'mc' | 'team' | 'lead' | 'drivers' | 'since' | 'status';
 @IsOptional() @IsIn(['asc', 'desc']) direction?: 'asc' | 'desc';
 @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100000) page?: number;
 @IsOptional() @Type(() => Number) @IsIn([20, 50, 100]) pageSize?: number;
}
/** Export takes the view on screen: the tab, filters and sort, never a page. */
export class MemberExportDto extends MemberFilters {
 @IsOptional() @IsIn(['ONBOARDING', 'ACTIVE', 'ON_LEAVE', 'LEAVING', 'LEFT', 'MISSING', 'ALL']) status?: 'ONBOARDING' | 'ACTIVE' | 'ON_LEAVE' | 'LEAVING' | 'LEFT' | 'MISSING' | 'ALL';
 @IsOptional() @IsIn(['name', 'mc', 'team', 'lead', 'drivers', 'since', 'status']) sort?: 'name' | 'mc' | 'team' | 'lead' | 'drivers' | 'since' | 'status';
 @IsOptional() @IsIn(['asc', 'desc']) direction?: 'asc' | 'desc';
}
export class StatusQueryDto {
 @IsOptional() @IsIn(['ONBOARDING', 'ACTIVE', 'ON_LEAVE', 'ARCHIVED', 'LEFT', 'ALL']) status?: 'ONBOARDING' | 'ACTIVE' | 'ON_LEAVE' | 'ARCHIVED' | 'LEFT' | 'ALL';
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
/** A move closes the current MC and team on startedAt and opens the new one. No teamId means Independent (no team) under that MC. */
export class MoveMemberDto {
 @IsInt() @Min(1) version!: number;
 // Every period names an MC: Independent is a team choice under it (section 31).
 @IsUUID(undefined, { message: 'Choose the MC they dispatch for.' }) mcId!: string;
 @ValidateIf((_object: unknown, value: unknown) => value !== null && value !== undefined) @IsUUID() teamId?: string | null;
 @IsDateString({ strict: true }) startedAt!: string;
 @text() @IsString() @MinLength(1, { message: 'Say why the dispatcher is moving.' }) @MaxLength(500) reason!: string;
}
/** Their first MC and team, for someone added with none. startedAt is optional: left out, the period follows their start date. */
export class PlaceMemberDto {
 @IsInt() @Min(1) version!: number;
 @IsUUID(undefined, { message: 'Choose the MC they dispatch for.' }) mcId!: string;
 @ValidateIf((_object: unknown, value: unknown) => value !== null && value !== undefined) @IsUUID() teamId?: string | null;
 @IsOptional() @IsDateString({ strict: true }) startedAt?: string;
}
/** A start date a manager found, or a correction of one, which needs a reason. */
export class StartDateDto {
 @IsInt() @Min(1) version!: number;
 @Matches(/^\d{4}-\d{2}-\d{2}$/) startedOn!: string;
 @text() @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
/** What a dispatch manager asks IT to set up for a support or updater (section 32), and a note for IT (never passwords). */
export class AskItDto {
 @IsArray() @ArrayMinSize(1, { message: 'Choose what IT should set up.' }) @ArrayMaxSize(4) @IsIn(SUPPORT_IT_ITEM_KEYS, { each: true }) items!: SupportItItem[];
 @text() @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
/** What a support is called: only the name changes. */
export class SupportTypeDto {
 @IsInt() @Min(1) version!: number;
 @IsIn(SUPPORT_TYPES) supportType!: SupportType;
}
/** Who a support assists from now: one dispatcher or one whole team. */
export class ReassignSupportDto {
 @IsInt() @Min(1) version!: number;
 @IsOptional() @IsUUID() dispatcherId?: string;
 @IsOptional() @IsUUID() teamId?: string;
 @IsDateString({ strict: true }) startedAt!: string;
 @text() @IsString() @MinLength(1, { message: 'Say why who they assist is changing.' }) @MaxLength(500) reason!: string;
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
/** Approving sets where they will work: an MC, and a team of it or none (Independent). Declining needs a note. */
export class DecidePromotionDto {
 @IsInt() @Min(1) version!: number;
 @IsIn(['APPROVE', 'DECLINE']) decision!: 'APPROVE' | 'DECLINE';
 @text() @IsOptional() @IsString() @MaxLength(1000) note?: string;
 @ValidateIf((object: DecidePromotionDto) => object.decision === 'APPROVE') @IsUUID(undefined, { message: 'Choose the MC they will dispatch for.' }) mcId?: string;
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
 // From Units (section 34): an owner-operator's own truck or a truck owner's, and a trailer; null clears one. An older page
 // sends truck text instead and neither field, which keeps the unit and trailer it can't show.
 @IsOptional() @IsUUID() unitId?: string | null;
 @IsOptional() @IsUUID() trailerId?: string | null;
 @text() @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
/**
 * An administrator's correction (section 36). Send only the fields that change. A dispatcher who came through onboarding
 * takes the application's fields; someone added by hand has a name only (firstName, lastName). A blank Telegram clears it.
 */
// Each American name part alone, so one letter is allowed (LATIN_NAME in documents.dto.ts checks a full name, two or more).
const LATIN = /^[A-Za-z][A-Za-z .,'-]*$/;
export class CorrectDetailsDto {
 @IsInt() @Min(1) version!: number;
 @text() @IsString() @MinLength(1, { message: 'Say why the details changed.' }) @MaxLength(500) reason!: string;
 @text() @ValidateIf(present) @IsString() @MinLength(1, { message: 'Enter their legal first name.' }) @MaxLength(100) legalFirstName?: string;
 @text() @ValidateIf(present) @IsString() @MinLength(1, { message: 'Enter their legal last name.' }) @MaxLength(100) legalLastName?: string;
 @text() @ValidateIf(present) @IsString() @MaxLength(100) @Matches(LATIN, { message: 'Use Latin letters for the American first name.' }) preferredAmericanFirstName?: string;
 @text() @ValidateIf(present) @IsString() @MaxLength(100) @Matches(LATIN, { message: 'Use Latin letters for the American last name.' }) preferredAmericanLastName?: string;
 @text() @ValidateIf(present) @IsEmail({}, { message: 'Enter a valid personal email.' }) @MaxLength(254) personalEmail?: string;
 @text() @ValidateIf(present) @IsString() @Matches(INTERNATIONAL_PHONE_PATTERN, { message: 'Use 7–15 digits; international formatting is accepted.' }) @MaxLength(40) personalPhoneNumber?: string;
 @text() @ValidateIf(blankOr) @IsString() @MaxLength(100) telegram?: string;
 @text() @ValidateIf(present) @IsString() @MinLength(1, { message: 'Enter their first name.' }) @MaxLength(100) firstName?: string;
 @text() @ValidateIf(present) @IsString() @MinLength(1, { message: 'Enter their last name.' }) @MaxLength(100) lastName?: string;
}
/** Leave (section 35): the first day away, the day they work again and why; what happens to their email and calls when they have them. */
export class LeaveDto {
 @IsInt() @Min(1) version!: number;
 @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Choose the first day away.' }) firstDay!: string;
 @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Choose the day they’re back.' }) backOn!: string;
 @text() @IsString() @MinLength(1, { message: 'Say why they’re away.' }) @MaxLength(1000) reason!: string;
 @IsOptional() @IsIn(['FORWARD', 'AUTO_REPLY']) emailWhileAway?: 'FORWARD' | 'AUTO_REPLY';
 @IsOptional() @IsIn(['FORWARD', 'VOICEMAIL']) callsWhileAway?: 'FORWARD' | 'VOICEMAIL';
}
export class BackOnDto {
 @IsInt() @Min(1) version!: number;
 @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Choose the day they’re back.' }) backOn!: string;
 @text() @IsString() @MinLength(1, { message: 'Say why the return date changed.' }) @MaxLength(1000) reason!: string;
}
export class LeaveReasonDto {
 @IsInt() @Min(1) version!: number;
 @text() @IsString() @MinLength(1, { message: 'Say why they’re away.' }) @MaxLength(1000) reason!: string;
}
export class LeaveVersionDto {
 @IsInt() @Min(1) version!: number;
}
/**
 * A scan of an NDA or SOP signed on paper (section 38): one PDF or photographed pages (exactly one of them), the paper date
 * when it was recorded wrong, and the confirmation that it is this person's signed document, every page.
 */
export class PaperScanDto extends ScanUploadDto {
 @IsInt() @Min(1) version!: number;
 @IsIn(['NDA', 'SOP']) kind!: 'NDA' | 'SOP';
 @IsOptional() @IsDateString({ strict: true }, { message: 'Enter a real date.' }) @Matches(/^\d{4}-\d{2}-\d{2}$/) signedOn?: string;
 @Equals(true, { message: 'Confirm that this is their signed document, every page.' }) confirmed!: boolean;
}
/** One other name, with the MC where it was used when known (section 33). Latin letters, as names are everywhere in the workspace. */
export class OtherNameDto {
 @text() @IsString() @MinLength(1, { message: 'Enter the name.' }) @MaxLength(100) @Matches(/^[A-Za-z][A-Za-z .'-]*$/, { message: 'Names use Latin letters only.' }) name!: string;
 @IsOptional() @IsUUID() mcId?: string;
}
/** Edit names: the legal name of someone added by hand ('' clears it), and the whole list of other names. */
export class MemberNamesDto {
 @IsInt() @Min(1) version!: number;
 @IsOptional() @text() @ValidateIf(blankOr) @IsString() @MaxLength(100) @Matches(/^[A-Za-z][A-Za-z .'-]*$/, { message: 'Names use Latin letters only.' }) legalFirstName?: string;
 @IsOptional() @text() @ValidateIf(blankOr) @IsString() @MaxLength(100) @Matches(/^[A-Za-z][A-Za-z .'-]*$/, { message: 'Names use Latin letters only.' }) legalLastName?: string;
 @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => OtherNameDto) otherNames!: OtherNameDto[];
}
/** The last day of someone added as Left without one. */
export class LeftDayDto {
 @IsInt() @Min(1) version!: number;
 @IsDateString({ strict: true }, { message: 'Enter a real date.' }) @Matches(/^\d{4}-\d{2}-\d{2}$/) leftOn!: string;
 @IsOptional() @text() @IsString() @MaxLength(500) reason?: string;
}
/** Ask IT to close the accounts of someone added as Left. */
export class CloseAccountsDto {
 @IsInt() @Min(1) version!: number;
 @IsIn(['FORWARD', 'SUSPEND']) emailAfter!: 'FORWARD' | 'SUSPEND';
 @IsOptional() @text() @IsString() @MaxLength(500) note?: string;
}
