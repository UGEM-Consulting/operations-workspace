import { text, filled } from './dto-helpers';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { NoSsn } from './pii';
export const TEST_KINDS = ['DRUG', 'ALCOHOL'] as const;
export const TEST_REASONS = ['RANDOM', 'POST_ACCIDENT', 'REASONABLE_SUSPICION', 'RETURN_TO_DUTY', 'FOLLOW_UP'] as const;
export const TEST_RESULTS = ['NEGATIVE', 'NOT_NEGATIVE', 'CANCELLED', 'REFUSED'] as const;

/** One drug or alcohol test result: results only, never substances, levels or medical details. */
export class RecordTestDto {
 @IsInt() @Min(1) version!: number;
 @IsIn(TEST_KINDS) kind!: typeof TEST_KINDS[number];
 @IsIn(TEST_REASONS) reason!: typeof TEST_REASONS[number];
 @IsString() @IsDateString({ strict: true }, { message: 'Enter a real date.' }) @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Enter the date of the test.' }) testedOn!: string;
 @IsIn(TEST_RESULTS) result!: typeof TEST_RESULTS[number];
 @NoSsn() @text() @IsOptional() @IsString() @ValidateIf(filled) @MaxLength(500) note?: string;
}
export class VoidTestDto {
 @IsInt() @Min(1) version!: number;
 @NoSsn() @text() @IsString() @MinLength(1, { message: 'Say why this entry is being voided.' }) @MaxLength(500) reason!: string;
}
