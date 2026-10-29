import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { listName } from './lists.entity';
const name = () => Transform(({ value }: { value: unknown }) => typeof value === 'string' ? listName(value) : value);
// Numbers are stored as digits only; spaces and an "MC" or "USDOT" prefix are dropped. '' clears an optional number.
const digits = () => Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.replace(/^\s*(mc|usdot|dot)[\s#-]*/i, '').replace(/[\s-]/g, '') : value);
const NUMBER = /^([0-9]{1,8})?$/;

export class ListQueryDto {
 @IsOptional() @IsIn(['ACTIVE', 'ARCHIVED', 'ALL']) status?: 'ACTIVE' | 'ARCHIVED' | 'ALL';
}
export class CreateJobTitleDto {
 @name() @IsString() @MinLength(1, { message: 'Enter a name.' }) @MaxLength(100) name!: string;
}
export class CreateMcDto extends CreateJobTitleDto {
 @digits() @IsOptional() @IsString() @Matches(NUMBER, { message: 'MC numbers are up to 8 digits.' }) mcNumber?: string;
 @digits() @IsOptional() @IsString() @Matches(NUMBER, { message: 'DOT numbers are up to 8 digits.' }) dotNumber?: string;
}
/** Every field is optional: send only what changed. `archived` archives or restores. */
export class UpdateJobTitleDto {
 @IsInt() @Min(1) version!: number;
 @name() @ValidateIf((_object: unknown, value: unknown) => value !== undefined) @IsString() @MinLength(1, { message: 'Enter a name.' }) @MaxLength(100) name?: string;
 @IsOptional() @IsBoolean() archived?: boolean;
}
export class UpdateMcDto extends UpdateJobTitleDto {
 @digits() @IsOptional() @IsString() @Matches(NUMBER, { message: 'MC numbers are up to 8 digits.' }) mcNumber?: string;
 @digits() @IsOptional() @IsString() @Matches(NUMBER, { message: 'DOT numbers are up to 8 digits.' }) dotNumber?: string;
}
