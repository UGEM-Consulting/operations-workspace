import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { listName } from '../lists/lists.entity';
const name = () => Transform(({ value }: { value: unknown }) => typeof value === 'string' ? listName(value) : value);
const text = () => Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value);
const present = (_object: unknown, value: unknown) => value !== undefined;

export class StatusQueryDto {
 @IsOptional() @IsIn(['ACTIVE', 'ARCHIVED', 'LEFT', 'ALL']) status?: 'ACTIVE' | 'ARCHIVED' | 'LEFT' | 'ALL';
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
export class LeaveMemberDto {
 @IsInt() @Min(1) version!: number;
 @IsDateString({ strict: true }) leftAt!: string;
 @text() @IsString() @MinLength(1, { message: 'Say why the dispatcher left.' }) @MaxLength(500) reason!: string;
}
export class UpdateMemberDto {
 @IsInt() @Min(1) version!: number;
 @ValidateIf((_object: unknown, value: unknown) => value !== null && value !== undefined) @IsUUID() jobTitleId?: string | null;
}
