import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** A page of Dispatchers for a viewer (section 39): a tab, a search by name or work contact, and the page. No filters or export. */
export class ViewMembersQueryDto {
  @IsOptional() @IsIn(['ONBOARDING', 'ACTIVE', 'ON_LEAVE', 'LEAVING', 'LEFT', 'ALL']) status?: 'ONBOARDING' | 'ACTIVE' | 'ON_LEAVE' | 'LEAVING' | 'LEFT' | 'ALL';
  @IsOptional() @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() || undefined : value) @IsString() @MaxLength(100) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100000) page?: number;
  @IsOptional() @Type(() => Number) @IsIn([20, 50, 100]) pageSize?: number;
}
