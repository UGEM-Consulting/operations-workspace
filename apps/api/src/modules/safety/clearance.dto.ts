import { text, filled } from './dto-helpers';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { CLEARANCE_STATUSES, type ClearanceStatus } from './safety.entity';
const DATE = /^\d{4}-\d{2}-\d{2}$/, MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const RESULTS = ['NEGATIVE', 'NOT_NEGATIVE', 'CANCELLED', 'NO_VIOLATIONS', 'VIOLATIONS'] as const;

/**
 * One clearance item against the driver's version. The drug test and the Clearinghouse query take `result` (which sets the
 * status); the others take `status`. `doneOn` is the date of the result or of completion. `status: null` with no result
 * sets the item back to not started.
 */
export class ClearanceItemDto {
 @IsInt() @Min(1) version!: number;
 @ValidateIf((_object: unknown, value: unknown) => value !== null && value !== undefined) @IsIn(CLEARANCE_STATUSES) status?: ClearanceStatus | null;
 @IsOptional() @IsIn(RESULTS) result?: typeof RESULTS[number];
 @IsOptional() @IsString() @ValidateIf(filled) @IsDateString({ strict: true }, { message: 'Enter a real date.' }) @Matches(DATE, { message: 'Enter a date.' }) doneOn?: string;
 @text() @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
/** A previous employer Safety asks about the driver's safety record. */
export class AddEmployerDto {
 @IsInt() @Min(1) version!: number;
 @text() @IsString() @MinLength(1, { message: 'Enter the employer’s name.' }) @MaxLength(200) name!: string;
 @IsString() @Matches(MONTH, { message: 'Enter the month they started.' }) fromMonth!: string;
 @IsString() @Matches(MONTH, { message: 'Enter the month they left.' }) toMonth!: string;
 @IsOptional() @IsString() @ValidateIf(filled) @IsDateString({ strict: true }, { message: 'Enter a real date.' }) @Matches(DATE, { message: 'Enter a date.' }) requestedOn?: string;
}
/**
 * When Safety asked the employer, when they answered, and the good-faith effort if they never did. Null clears an answer
 * or an effort recorded by mistake; a request stays once recorded.
 */
export class UpdateEmployerDto {
 @IsInt() @Min(1) version!: number;
 @ValidateIf(filled) @IsString() @IsDateString({ strict: true }, { message: 'Enter a real date.' }) @Matches(DATE, { message: 'Enter a date.' }) requestedOn?: string | null;
 @ValidateIf(filled) @IsString() @IsDateString({ strict: true }, { message: 'Enter a real date.' }) @Matches(DATE, { message: 'Enter a date.' }) answeredOn?: string | null;
 @ValidateIf(filled) @IsString() @IsDateString({ strict: true }, { message: 'Enter a real date.' }) @Matches(DATE, { message: 'Enter a date.' }) goodFaithOn?: string | null;
 @text() @IsOptional() @IsString() @MaxLength(500) goodFaithNote?: string;
}
