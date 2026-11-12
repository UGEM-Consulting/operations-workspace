import { ArrayMaxSize, ArrayMinSize, IsArray, IsBase64, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import { MAX_PDF_BYTES, MAX_PHOTO_BYTES } from '../documents/documents.dto';
import { MAX_SCAN_PAGES } from './scan';

/**
 * A document Safety or Dispatch has in hand: one PDF or photographed pages. Each is checked only when sent; exactly one of
 * them is required by oneUpload, so a request with neither gets its friendly message. Shared by renewals and paper scans.
 */
export class ScanUploadDto {
 @ValidateIf(dto => dto.file !== undefined) @IsString() @IsBase64() @MaxLength(Math.ceil(MAX_PDF_BYTES / 3) * 4) file?: string;
 @IsOptional() @IsArray() @ArrayMinSize(1, { message: 'Add at least one page.' }) @ArrayMaxSize(MAX_SCAN_PAGES, { message: `Photograph at most ${MAX_SCAN_PAGES} pages.` })
 @IsString({ each: true }) @IsBase64({}, { each: true }) @MaxLength(Math.ceil(MAX_PHOTO_BYTES / 3) * 4, { each: true }) pages?: string[];
}
