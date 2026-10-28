import { Transform } from 'class-transformer';
import { Equals, IsBase64, IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { DOCUMENT_KINDS, SIGNATURE_METHODS, type DocumentKind, type SignatureMethod } from './documents.entity';
const trim = () => Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value);
// Size limits are on the base64 text; the decoded files are checked again in the service.
export const MAX_PHOTO_BYTES = 2_500_000, MAX_PDF_BYTES = 3_000_000, MAX_SIGNATURE_BYTES = 200_000;
const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;
export class SignatureDto {
 // Latin letters as on the signer's ID: the signature certificate uses standard PDF fonts.
 @trim() @IsString() @MinLength(2) @MaxLength(100) @Matches(/^[A-Za-z][A-Za-z .,'-]*$/, { message: 'Type your full legal name in Latin letters, as on your ID.' }) typedName!: string;
 @ValidateIf((_object: unknown, value: unknown) => value !== undefined) @IsString() @MaxLength(base64Length(MAX_SIGNATURE_BYTES) + 22)
 @Matches(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/, { message: 'Draw your signature.' }) signature?: string;
 // How the signature image was made: drawn by hand, or adopted from the typed name. Defaults to drawn.
 @IsOptional() @IsIn(SIGNATURE_METHODS) signatureMethod?: SignatureMethod;
 @Equals(true, { message: 'Confirm the signature statement.' }) agreed!: boolean;
}
// The approving manager's NDA countersignature: signed here, or applied from their saved signature.
export class CountersignatureDto {
 @IsOptional() @IsBoolean() useSavedSignature?: boolean;
 @ValidateIf((object: CountersignatureDto) => !object.useSavedSignature)
 @trim() @IsString() @MinLength(2) @MaxLength(100) @Matches(/^[A-Za-z][A-Za-z .,'-]*$/, { message: 'Type your full legal name in Latin letters, as on your ID.' }) typedName?: string;
 @ValidateIf((object: CountersignatureDto, value: unknown) => !object.useSavedSignature && value !== undefined) @IsString() @MaxLength(base64Length(MAX_SIGNATURE_BYTES) + 22)
 @Matches(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/, { message: 'Draw your signature.' }) signature?: string;
 @IsOptional() @IsIn(SIGNATURE_METHODS) signatureMethod?: SignatureMethod;
 @Equals(true, { message: 'Confirm the signature statement.' }) agreed!: boolean;
}
// Saving a countersigning signature for later approvals; a fresh image is always required.
export class SaveSignatureDto {
 @trim() @IsString() @MinLength(2) @MaxLength(100) @Matches(/^[A-Za-z][A-Za-z .,'-]*$/, { message: 'Type your full legal name in Latin letters, as on your ID.' }) typedName!: string;
 @IsString() @MaxLength(base64Length(MAX_SIGNATURE_BYTES) + 22)
 @Matches(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/, { message: 'Draw or adopt your signature.' }) signature!: string;
 @IsIn(SIGNATURE_METHODS) signatureMethod!: SignatureMethod;
 @Equals(true, { message: 'Confirm that you adopt this signature.' }) agreed!: boolean;
}
export class ApplicantSignatureDto extends SignatureDto {
 @Equals(true, { message: 'Agree to sign electronically first.' }) consent!: boolean;
}
export class PhotoDto {
 @IsString() @IsBase64() @MaxLength(base64Length(MAX_PHOTO_BYTES)) image!: string;
}
export class PublishDocumentDto {
 @IsIn(DOCUMENT_KINDS) kind!: DocumentKind;
 @trim() @IsString() @MinLength(1) @MaxLength(200) title!: string;
 @IsString() @IsBase64() @MaxLength(base64Length(MAX_PDF_BYTES)) file!: string;
}
