import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsIn, IsInt, IsString, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { INTERNATIONAL_PHONE_PATTERN } from '../onboarding/application-requirements';
import { REQUEST_STATUSES, RequestStatus, TASK_STATUSES, TaskStatus } from './it.entity';
const trim=()=>Transform(({value}:{value:unknown})=>typeof value==='string'?value.trim():value);
export class TaskUpdateDto {
 @IsInt() @Min(0) version!:number;
 @IsIn(TASK_STATUSES) status!:TaskStatus;
 @trim() @IsString() @MaxLength(1000) notes='';
}
export class ItContactDto {
 @IsInt() @Min(0) version!:number;
 @IsBoolean() workPhoneVerified!:boolean;
 @ValidateIf((_object:unknown,value:unknown)=>value!==undefined) @trim() @IsString() @MaxLength(40)
 @Matches(new RegExp(`^(?:$|${INTERNATIONAL_PHONE_PATTERN.source.slice(1,-1)})$`)) assignedRingCentralPhoneNumber?:string;
 // Omitted keeps the recorded value; an empty string clears it.
 @Transform(({value}:{value:unknown})=>typeof value==='string'?value.trim().toLowerCase():value)
 @ValidateIf((_object:unknown,value:unknown)=>value!==undefined&&value!=='') @IsEmail() @MaxLength(254) companyEmail?:string;
}
export class ItQueueDto {
 @Type(()=>Number) @IsInt() @Min(1) @Max(100000) page=1;
 @Type(()=>Number) @IsInt() @Min(1) @Max(50) pageSize=20;
 @IsIn(['ALL',...REQUEST_STATUSES]) status:RequestStatus|'ALL'='ALL';
 @trim() @IsString() @MaxLength(100) search='';
}
