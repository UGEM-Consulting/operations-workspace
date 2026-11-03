import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBase64, IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { MAX_PDF_BYTES } from '../documents/documents.dto';
import { DocumentFieldDto, MAX_FIELDS } from '../documents/fields';
import { CONSENT_KINDS, type ConsentKind } from './consent.entity';

/** A new version of a consent form: the kind, the title drivers see and the PDF (base64, 3 MB at most). */
export class PublishConsentDto {
 @IsIn(CONSENT_KINDS) kind!: ConsentKind;
 @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value) @IsString() @MinLength(1) @MaxLength(200) title!: string;
 @IsString() @IsBase64() @MaxLength(Math.ceil(MAX_PDF_BYTES / 3) * 4) file!: string;
 @IsOptional() @IsArray() @ArrayMaxSize(MAX_FIELDS) @ValidateNested({ each: true }) @Type(() => DocumentFieldDto) fields?: DocumentFieldDto[];
}
