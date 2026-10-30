import { Transform } from 'class-transformer';
import { IsBase64, IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { MAX_PDF_BYTES } from '../documents/documents.dto';
import { SCREENING_RESULTS, type ScreeningResult } from './safety.entity';
const text = () => Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value);
const filled = (_object: unknown, value: unknown) => value !== undefined && value !== null && value !== '';
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** One screening check against the driver's version: a result (a concern needs a note), or null to clear it. */
export class ScreeningCheckDto {
 @IsInt() @Min(1) version!: number;
 @ValidateIf((_object: unknown, value: unknown) => value !== null) @IsIn(SCREENING_RESULTS) result!: ScreeningResult | null;
 @text() @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
/** The driver's MVR as a base64 PDF, and the date Safety pulled it. */
export class UploadMvrDto {
 @IsInt() @Min(1) version!: number;
 @IsString() @IsBase64() @MaxLength(Math.ceil(MAX_PDF_BYTES / 3) * 4) file!: string;
 @IsString() @IsDateString({ strict: true }, { message: 'Enter a real date.' }) @Matches(DATE, { message: 'Enter the date the MVR was pulled.' }) pulledOn!: string;
}
/** Sends the application back to the driver; the message is shown to the driver. */
export class RequestCorrectionsDto {
 @IsInt() @Min(1) version!: number;
 @text() @IsString() @MinLength(1, { message: 'Tell the driver what to correct.' }) @MaxLength(1000) message!: string;
}
/** Hands a screened driver to the Safety manager, with an optional summary. */
export class SendForDecisionDto {
 @IsInt() @Min(1) version!: number;
 @text() @IsOptional() @IsString() @MaxLength(2000) note?: string;
}
export const DECISIONS = ['APPROVE', 'MORE_INFO', 'PRE_ADVERSE', 'REJECT'] as const;
export type Decision = typeof DECISIONS[number];
/**
 * The Safety manager's decision. `note` is the reason (required except for approval); `conditions` only with approval.
 * PRE_ADVERSE and REJECT record the date Safety sent the notice and need `noticeSent` confirmed.
 */
export class DecisionDto {
 @IsInt() @Min(1) version!: number;
 @IsIn(DECISIONS) decision!: Decision;
 @text() @IsOptional() @IsString() @MaxLength(2000) note?: string;
 @text() @IsOptional() @IsString() @MaxLength(1000) conditions?: string;
 @IsOptional() @IsString() @ValidateIf(filled) @IsDateString({ strict: true }, { message: 'Enter a real date.' }) @Matches(DATE, { message: 'Enter the date the notice was sent.' }) noticeSentOn?: string;
 @IsOptional() @IsBoolean() noticeSent?: boolean;
}
