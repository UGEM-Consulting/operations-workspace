import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { INTERNATIONAL_PHONE_PATTERN } from '../onboarding/application-requirements';
import { NUMBER_OUTCOMES, NumberOutcome, REQUEST_STATUSES, RequestStatus, TASK_STATUSES, TaskStatus } from './it.entity';
const trim=()=>Transform(({value}:{value:unknown})=>typeof value==='string'?value.trim():value);
export class TaskUpdateDto {
 @IsInt() @Min(0) version!:number;
 @IsIn(TASK_STATUSES) status!:TaskStatus;
 // Omitted keeps the recorded notes; an empty string clears them.
 @IsOptional() @trim() @IsString() @MaxLength(1000) notes?:string;
}
export class ItContactDto {
 @IsInt() @Min(0) version!:number;
 @IsBoolean() workPhoneVerified!:boolean;
 @ValidateIf((_object:unknown,value:unknown)=>value!==undefined) @trim() @IsString() @MaxLength(40)
 @Matches(new RegExp(`^(?:$|${INTERNATIONAL_PHONE_PATTERN.source.slice(1,-1)})$`)) assignedRingCentralPhoneNumber?:string;
 // Omitted keeps the recorded value; an empty string clears it.
 @Transform(({value}:{value:unknown})=>typeof value==='string'?value.trim().toLowerCase():value)
 @ValidateIf((_object:unknown,value:unknown)=>value!==undefined&&value!=='') @IsEmail() @MaxLength(254) companyEmail?:string;
 // Also optional, and never needed to finish setup. Load board fields take a sign-in email, never a password.
 @IsOptional() @trim() @Matches(/^(?:|\d{1,6})$/,{message:'The extension should be digits, up to 6.'}) ringCentralExtension?:string;
 @Transform(({value}:{value:unknown})=>typeof value==='string'?value.trim().toLowerCase():value)
 @ValidateIf((_object:unknown,value:unknown)=>value!==undefined&&value!=='') @IsEmail({},{message:'A load board sign-in takes the sign-in email only, never a password.'}) @MaxLength(254) datEmail?:string;
 @Transform(({value}:{value:unknown})=>typeof value==='string'?value.trim().toLowerCase():value)
 @ValidateIf((_object:unknown,value:unknown)=>value!==undefined&&value!=='') @IsEmail({},{message:'A load board sign-in takes the sign-in email only, never a password.'}) @MaxLength(254) truckstopEmail?:string;
}
export class ItQueueDto {
 @Type(()=>Number) @IsInt() @Min(1) @Max(100000) page=1;
 @Type(()=>Number) @IsInt() @Min(1) @Max(50) pageSize=20;
 @IsIn(['ALL',...REQUEST_STATUSES]) status:RequestStatus|'ALL'='ALL';
 @trim() @IsString() @MaxLength(100) search='';
}
/** A removal task. Completing RingCentral records what happens to the number (kept, forwarded or released). */
export class RemovalTaskDto extends TaskUpdateDto {
 @IsOptional() @IsIn(NUMBER_OUTCOMES) numberOutcome?:NumberOutcome;
}
/** IT tasks: setups and removals in one list. Open is every unfinished task; Setup and Removal the open ones of each, due removals only; Scheduled the removals not due yet. */
export const TASK_VIEWS=['open','setup','signin','leave','accounts','removal','scheduled','finished','all'] as const;
export class ItTasksDto {
 @Type(()=>Number) @IsInt() @Min(1) @Max(100000) page=1;
 @Type(()=>Number) @IsInt() @Min(1) @Max(50) pageSize=20;
 @IsIn(TASK_VIEWS) view:typeof TASK_VIEWS[number]='open';
 @trim() @IsString() @MaxLength(100) search='';
 // Team lead sign-ins are listed only for pages that know them ('1'), so an older page never meets a row it can't read.
 @IsOptional() @IsIn(['1']) signIns?:'1';
 // Suspends and restores for someone on leave (section 35), the same way: only pages that know them ask.
 @IsOptional() @IsIn(['1']) leave?:'1';
 // Requests about company accounts (section 33): close one, or a move's new accounts.
 @IsOptional() @IsIn(['1']) accounts?:'1';
}
