import { IsBoolean, IsEnum, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { MfaMethod, MfaPolicy } from './mfa.entity';
export class MfaCodeDto {
  // Six-digit authenticator code or an XXXXX-XXXXX recovery code.
  @IsString() @MaxLength(20) @Matches(/^[\s0-9A-Za-z-]{6,20}$/) code!: string;
}
export class MfaPolicyDto { @IsEnum(MfaPolicy) mfaRequiredFor!: MfaPolicy; }
// Older clients send no body and get an authenticator app.
export class MfaEnrolmentDto { @IsOptional() @IsEnum(MfaMethod) method?: MfaMethod; }
export class MfaChallengeDto { @IsOptional() @IsBoolean() resend?: boolean; }
// Starting a new authenticator: a current or recovery code, which may be left out just after a recovery-code sign-in.
export class MfaReplacementDto {
  @IsOptional() @IsString() @MaxLength(20) @Matches(/^[\s0-9A-Za-z-]{6,20}$/) code?: string;
}
// Confirming it: the new authenticator's first code, for the setup that was shown (replacementId from the start).
export class MfaReplacementConfirmDto extends MfaCodeDto {
  @IsString() @Matches(/^[0-9a-f]{32}$/) replacementId!: string;
}
