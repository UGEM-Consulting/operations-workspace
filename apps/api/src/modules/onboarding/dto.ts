import { INTERNATIONAL_PHONE_PATTERN } from './application-requirements';
import { VERIFICATION_CODE_PATTERN } from './verification-code';
import { APPLICATION_STATUSES, REQUESTABLE_ITEMS, ApplicationStatus, RequestableItem, DecisionType } from './entities';
import { CountersignatureDto } from '../documents/documents.dto';
import { Type, Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayUnique, IsArray, IsIn, Equals, IsBoolean, IsEmail, IsInt, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';
const optional = () => ValidateIf((_object: unknown, value: unknown) => value !== undefined);
const trim = () => Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value);
export class CreateInvitationDto {
 @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toLowerCase() || undefined : value) @optional() @IsEmail() @MaxLength(254) email?: string;
 @optional() @trim() @IsString() @MinLength(1) @MaxLength(150) mcName?: string;
 @optional() @trim() @IsString() @MinLength(1) @MaxLength(150) teamLead?: string;
 @optional() @trim() @IsString() @MinLength(1) @MaxLength(100) jobTitle?: string;
 // A support skips the employment questions and has no IT setup; supportsMemberId is the dispatcher they assist.
 @optional() @IsIn(['DISPATCHER','SUPPORT']) position?: 'DISPATCHER' | 'SUPPORT';
 @optional() @IsUUID() supportsMemberId?: string;
 @IsInt() @Min(1) @Max(30) expirationDays = 7;
 @IsBoolean() telegramRequired = false;
}
export class BeginVerificationDto {
 @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toLowerCase() : value) @IsEmail() @MaxLength(254) email!: string;
 @optional() @IsString() @Matches(/^[a-f0-9]{64}$/) token?: string;
 @optional() @IsUUID() applicationId?: string;
}
export class VerifyApplicantDto {
 @IsUUID() challengeId!: string;
 @IsString() @Matches(VERIFICATION_CODE_PATTERN) code!: string;
}
export class DraftDto {
 @IsInt() @Min(0) version!: number;
 @optional() @trim() @IsString() @MaxLength(100) firstName?: string;
 @optional() @trim() @IsString() @MaxLength(100) lastName?: string;
 @ValidateIf((_object: unknown, value: unknown) => value !== undefined && value !== '') @trim() @IsString() @Matches(INTERNATIONAL_PHONE_PATTERN) @MaxLength(40) personalPhoneNumber?: string;
 @ValidateIf((_object: unknown, value: unknown) => value !== undefined && value !== '') @trim() @IsString() @Matches(INTERNATIONAL_PHONE_PATTERN) @MaxLength(40) workPhoneNumber?: string;
 @optional() @trim() @IsString() @MaxLength(100) preferredAmericanFirstName?: string;
 @optional() @trim() @IsString() @MaxLength(100) preferredAmericanLastName?: string;
 @optional() @trim() @IsString() @MaxLength(100) telegram?: string;
 @optional() @trim() @IsString() @MaxLength(150) mcName?: string;
 @optional() @trim() @IsString() @MaxLength(150) teamLead?: string;
 @optional() @trim() @IsString() @MaxLength(100) jobTitle?: string;
}
export class SubmitDto extends DraftDto {
 @trim() @IsString() @MinLength(1) @MaxLength(100) declare firstName: string;
 @trim() @IsString() @MinLength(1) @MaxLength(100) declare lastName: string;
 @trim() @IsString() @Matches(INTERNATIONAL_PHONE_PATTERN) declare personalPhoneNumber: string;
 @trim() @IsString() @MinLength(1) @MaxLength(100) declare preferredAmericanFirstName: string;
 @trim() @IsString() @MinLength(1) @MaxLength(100) declare preferredAmericanLastName: string;
 @Equals(true) accurate!: boolean;
}

export class EmploymentAssignmentsDto {
 @trim() @IsString() @MinLength(1) @MaxLength(150) mcName!: string;
 @trim() @IsString() @MinLength(1) @MaxLength(150) teamLead!: string;
 @trim() @IsString() @MinLength(1) @MaxLength(100) jobTitle!: string;
}
export class ReviewDto {
 // Approving a support: the dispatcher they assist (defaults to the one on the invitation).
 @optional() @IsUUID() supportsMemberId?: string;
 @IsInt() @Min(0) version!: number;
 @IsIn(['APPROVE','REQUEST_CHANGES','REJECT']) decisionType!: DecisionType;
 @optional() @trim() @IsString() @MaxLength(2000) reason?: string;
 @IsArray() @ArrayMaxSize(REQUESTABLE_ITEMS.length) @ArrayUnique() @IsIn(REQUESTABLE_ITEMS, { each: true }) requestedFields: RequestableItem[] = [];
 @IsBoolean() confirmed = false;
 @IsBoolean() employmentConfirmed = false;
 @optional() @ValidateNested() @Type(() => EmploymentAssignmentsDto) employment?: EmploymentAssignmentsDto;
 // The approving manager's NDA countersignature; required when the applicant signed an NDA.
 @optional() @ValidateNested() @Type(() => CountersignatureDto) countersignature?: CountersignatureDto;
}
export class ApplicationQueryDto {
 @Type(() => Number) @IsInt() @Min(1) @Max(100000) page = 1;
 @Type(() => Number) @IsInt() @Min(1) @Max(50) pageSize = 20;
 @IsIn(['ALL', 'AWAITING_REVIEW', ...APPLICATION_STATUSES]) status: ApplicationStatus | 'ALL' | 'AWAITING_REVIEW' = 'ALL';
 @trim() @IsString() @MaxLength(100) search = '';
 @IsIn(['updatedAt','submittedAt','name','status']) sort = 'updatedAt';
 @IsIn(['ASC','DESC']) direction: 'ASC' | 'DESC' = 'DESC';
}
/** How the applicant wants to hear about decisions; at least one channel. */
export class UpdatePreferencesDto {
 @IsBoolean() email!: boolean;
 @IsBoolean() telegram!: boolean;
}
