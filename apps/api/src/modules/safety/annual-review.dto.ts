import { Transform, Type } from 'class-transformer';
import { IsBase64, IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import { MAX_PDF_BYTES } from '../documents/documents.dto';
const text = () => Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value);
const filled = (_object: unknown, value: unknown) => value !== undefined && value !== null && value !== '';
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The new MVR for a yearly review: a base64 PDF and the date it was pulled. */
export class AnnualMvrDto {
 @IsString() @IsBase64() @MaxLength(Math.ceil(MAX_PDF_BYTES / 3) * 4) file!: string;
 @IsString() @IsDateString({ strict: true }, { message: 'Enter a real date.' }) @Matches(DATE, { message: 'Enter the date the MVR was pulled.' }) pulledOn!: string;
 // Needed when the driver hasn't signed the background check authorization in the workspace.
 @IsOptional() @IsBoolean() paperAuthorization?: boolean;
}
/** One yearly review of a cleared driver's driving record (FMCSA 391.25). A note is required unless the driver stays qualified. */
export class AnnualReviewDto {
 @IsInt() @Min(1) version!: number;
 @IsString() @IsDateString({ strict: true }, { message: 'Enter a real date.' }) @Matches(DATE, { message: 'Enter the date of the review.' }) reviewedOn!: string;
 @IsIn(['QUALIFIED', 'NOT_QUALIFIED']) outcome!: 'QUALIFIED' | 'NOT_QUALIFIED';
 @text() @IsOptional() @IsString() @ValidateIf(filled) @MaxLength(1000) note?: string;
 @IsOptional() @ValidateNested() @Type(() => AnnualMvrDto) mvr?: AnnualMvrDto;
}
