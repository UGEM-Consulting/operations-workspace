import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { Equals, IsEmail, IsEnum, ValidateIf, IsString, IsUUID, MaxLength, MinLength, Matches } from 'class-validator';
import { PartialType } from '@nestjs/swagger';
import { Role, UserStatus } from './user.entity';
/** The one staff password rule: 12–128 characters (administrator-set, self-service and bootstrap passwords alike). */
export const StaffPassword = () => applyDecorators(IsString(), MinLength(12), MaxLength(128));
export class CreateUserDto {
  @IsString() @MinLength(1) @MaxLength(100) @Matches(/\S/) firstName!: string;
  @IsString() @MinLength(1) @MaxLength(100) @Matches(/\S/) lastName!: string;
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsEmail() @MaxLength(254) email!: string;
  // Left out, the API generates a first password and returns it once. Older pages still send one.
  @ValidateIf((_object, value) => value !== undefined) @StaffPassword() password?: string;
  @IsEnum(Role) role!: Role;
  @ValidateIf((_object, value) => value !== undefined) @IsEnum(UserStatus) status?: UserStatus;
  // A team lead's dispatcher record (required for TEAM_LEAD, ignored otherwise; omitted keeps the current link).
  @ValidateIf((_object, value) => value !== undefined && value !== null) @IsUUID() memberId?: string | null;
}
export class UpdateUserDto extends PartialType(CreateUserDto, { skipNullProperties: false }) {
  // Who takes over a manager's open invitations and applications when this change deactivates them or changes their role.
  @ValidateIf((_object, value) => value !== undefined) @IsUUID() handOverTo?: string;
  // Replaces their password with a generated one, returned once.
  @ValidateIf((_object, value) => value !== undefined) @Equals(true) generatePassword?: true;
}
