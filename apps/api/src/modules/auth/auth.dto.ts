import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { StaffPassword } from '../users/users.dto';
export class LoginDto {
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsEmail() @MaxLength(254) email!: string;
  @IsString() @MinLength(1) @MaxLength(128) password!: string;
}
export class ChangePasswordDto {
  @IsString() @MinLength(1) @MaxLength(128) currentPassword!: string;
  @StaffPassword() newPassword!: string;
}
