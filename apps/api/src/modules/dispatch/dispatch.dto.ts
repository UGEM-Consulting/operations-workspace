import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { INTERNATIONAL_PHONE_PATTERN } from '../onboarding/application-requirements';
import { listName } from '../lists/lists.entity';
const name = () => Transform(({ value }: { value: unknown }) => typeof value === 'string' ? listName(value) : value);
const text = () => Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value);
const present = (_object: unknown, value: unknown) => value !== undefined;

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
export class LeaveMemberDto {
 @IsInt() @Min(1) version!: number;
 @IsDateString({ strict: true }) leftAt!: string;
 @text() @IsString() @MinLength(1, { message: 'Say why the dispatcher left.' }) @MaxLength(500) reason!: string;
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
