import { Equals, IsDateString, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min, ValidateIf } from 'class-validator';
import { filled, text } from './dto-helpers';
import { ScanUploadDto } from './scan.dto';
import { RENEWAL_KINDS, type RenewalKind } from './safety.entity';
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A renewal link for one document, against the driver's version. */
export class RenewalLinkDto {
 @IsInt() @Min(1) version!: number;
 @IsIn(RENEWAL_KINDS) kind!: RenewalKind;
}
/**
 * A renewed document Safety has in hand: a PDF or photographed pages (exactly one of them), the expiration date a person
 * read on it and their confirmation that it is the driver's. It is saved already checked.
 */
export class RenewDocumentDto extends ScanUploadDto {
 @IsInt() @Min(1) version!: number;
 @IsIn(RENEWAL_KINDS) kind!: RenewalKind;
 @IsDateString({ strict: true }, { message: 'Enter a real date.' }) @Matches(DATE, { message: 'Enter the expiration as a full date.' }) expiresOn!: string;
 @text() @IsOptional() @IsString() @ValidateIf(filled) @MaxLength(40) number?: string;
 @Equals(true, { message: 'Confirm that this is the driver’s document and the date matches it.' }) confirmed!: boolean;
}
/** Marking a renewal scan as not readable, against the version of the document the person opened. */
export class DocumentVersionDto { @IsInt() @Min(1) version!: number; }
