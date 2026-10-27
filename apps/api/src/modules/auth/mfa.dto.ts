import { IsEnum, IsString, Matches, MaxLength } from 'class-validator';
import { MfaPolicy } from './mfa.entity';
export class MfaCodeDto {
  // Six-digit authenticator code or an XXXXX-XXXXX recovery code.
  @IsString() @MaxLength(20) @Matches(/^[\s0-9A-Za-z-]{6,20}$/) code!: string;
}
export class MfaPolicyDto { @IsEnum(MfaPolicy) mfaRequiredFor!: MfaPolicy; }
