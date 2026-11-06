import { text, filled } from './dto-helpers';
import { Transform } from 'class-transformer';
import { IsBase64, IsDateString, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { MAX_PDF_BYTES } from '../documents/documents.dto';
import { US_STATES } from './safety.entity';
const upper = () => Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.replace(/\s+/g, '').toUpperCase() : value);
export const OWNER_DOCUMENT_KINDS = ['LEASE', 'INSURANCE', 'REGISTRATION'] as const;

/** An owner-operator's truck. The VIN has 17 characters and never I, O or Q. */
export class TruckDto {
 @IsInt() @Min(1) version!: number;
 @text() @IsString() @MinLength(1, { message: 'Enter the unit number.' }) @MaxLength(20) unit!: string;
 @upper() @IsString() @Matches(/^[A-HJ-NPR-Z0-9]{17}$/, { message: 'A VIN has 17 letters and numbers, never I, O or Q.' }) vin!: string;
 @IsInt() @Min(1980) @Max(2100) year!: number;
 @text() @IsString() @MinLength(1, { message: 'Enter the make.' }) @MaxLength(40) make!: string;
 @upper() @IsOptional() @IsString() @ValidateIf(filled) @MaxLength(12) plate?: string;
 @upper() @IsOptional() @IsString() @ValidateIf(filled) @IsIn(US_STATES, { message: 'Choose a state.' }) plateState?: string;
}
export class ArchiveTruckDto { @IsInt() @Min(1) version!: number; }
/** A lease, insurance or registration PDF for a truck, with the expiration date shown on it (required except for a lease). */
export class OwnerDocumentDto {
 @IsInt() @Min(1) version!: number;
 @IsIn(OWNER_DOCUMENT_KINDS) kind!: typeof OWNER_DOCUMENT_KINDS[number];
 @IsString() @IsBase64() @MaxLength(Math.ceil(MAX_PDF_BYTES / 3) * 4) file!: string;
 @IsOptional() @IsString() @ValidateIf(filled) @IsDateString({ strict: true }, { message: 'Enter a real date.' }) @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Enter the expiration as a full date.' }) expiresOn?: string;
}
