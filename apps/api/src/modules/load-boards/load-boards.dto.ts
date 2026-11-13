import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { listName } from '../lists/lists.entity';
import { PROVIDERS, type Provider } from './load-boards.entity';
const name = () => Transform(({ value }: { value: unknown }) => typeof value === 'string' ? listName(value) : value);
const email = () => Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toLowerCase() : value);
const SIGN_IN = 'A load board sign-in takes the sign-in email only, never a password.';
const DAY = { message: 'Enter a real date.' };

export class AccountQueryDto {
 @IsOptional() @IsIn(['ACTIVE', 'ARCHIVED', 'ALL']) status?: 'ACTIVE' | 'ARCHIVED' | 'ALL';
}
/** One of the company's DAT or Truckstop accounts, under one of our MCs or another company's name. */
export class CreateAccountDto {
 @IsIn(PROVIDERS) provider!: Provider;
 @name() @IsString() @MinLength(1, { message: 'Enter a name.' }) @MaxLength(100) name!: string;
 @IsOptional() @IsUUID() mcId?: string;
 @IsOptional() @name() @IsString() @MaxLength(100) companyName?: string;
}
/** Only what changed. `archived` archives or restores; '' clears the other company's name. */
export class UpdateAccountDto {
 @IsInt() @Min(1) version!: number;
 @name() @ValidateIf((_object: unknown, value: unknown) => value !== undefined) @IsString() @MinLength(1, { message: 'Enter a name.' }) @MaxLength(100) name?: string;
 @ValidateIf((_object: unknown, value: unknown) => value !== undefined && value !== null) @IsUUID() mcId?: string | null;
 @IsOptional() @name() @IsString() @MaxLength(100) companyName?: string;
 @IsOptional() @IsBoolean() archived?: boolean;
}
/** A seat is picked from the list, never typed; the sign-in is any email, never a password. */
export class AddSeatDto {
 @IsUUID() memberId!: string;
 @IsUUID() accountId!: string;
 @email() @IsEmail({}, { message: SIGN_IN }) @MaxLength(254) signInEmail!: string;
 @IsDateString({ strict: true }, DAY) @Matches(/^\d{4}-\d{2}-\d{2}$/) startedOn!: string;
}
/** Suspend keeps a seat, Resume gives it back, Move ends it and opens one on another account, End closes it, Email changes the sign-in. */
export class ChangeSeatDto {
 @IsInt() @Min(1) version!: number;
 @IsIn(['SUSPEND', 'RESUME', 'MOVE', 'END', 'EMAIL']) action!: 'SUSPEND' | 'RESUME' | 'MOVE' | 'END' | 'EMAIL';
 @ValidateIf((dto: ChangeSeatDto) => dto.action === 'MOVE') @IsUUID() accountId?: string;
 @ValidateIf((dto: ChangeSeatDto) => dto.action === 'EMAIL' || dto.signInEmail !== undefined) @email() @IsEmail({}, { message: SIGN_IN }) @MaxLength(254) signInEmail?: string;
 @ValidateIf((dto: ChangeSeatDto) => ['SUSPEND', 'MOVE', 'END'].includes(dto.action) || dto.on !== undefined) @IsDateString({ strict: true }, DAY) @Matches(/^\d{4}-\d{2}-\d{2}$/) on?: string;
}
