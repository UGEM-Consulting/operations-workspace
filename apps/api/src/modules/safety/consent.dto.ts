import { Transform } from 'class-transformer';
import { IsBase64, IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import { MAX_PDF_BYTES } from '../documents/documents.dto';
import { CONSENT_KINDS, type ConsentKind } from './consent.entity';

/** A new version of a consent form: the kind, the title drivers see and the PDF (base64, 3 MB at most). */
export class PublishConsentDto {
 @IsIn(CONSENT_KINDS) kind!: ConsentKind;
 @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value) @IsString() @MinLength(1) @MaxLength(200) title!: string;
 @IsString() @IsBase64() @MaxLength(Math.ceil(MAX_PDF_BYTES / 3) * 4) file!: string;
}
