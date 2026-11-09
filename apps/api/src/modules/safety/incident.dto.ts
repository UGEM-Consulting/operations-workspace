import { text, upper, filled } from './dto-helpers';
import { IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { US_STATES } from './safety.entity';
import { NoSsn } from './pii';
export const INCIDENT_KINDS = ['ACCIDENT', 'VIOLATION', 'INSPECTION'] as const;
type Kind = typeof INCIDENT_KINDS[number];
const only = (kind: Kind) => (object: { kind?: Kind }) => object.kind === kind;

/**
 * One accident, violation or roadside inspection of a cleared driver. A short factual summary only: no names of other
 * people, no medical details, no police report numbers. Fields that belong to another kind are refused.
 */
export class RecordIncidentDto {
 @IsInt() @Min(1) version!: number;
 @IsIn(INCIDENT_KINDS) kind!: Kind;
 @IsString() @IsDateString({ strict: true }, { message: 'Enter a real date.' }) @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Enter the date it happened.' }) occurredOn!: string;
 @upper() @IsOptional() @IsString() @ValidateIf(filled) @IsIn(US_STATES, { message: 'Choose a state.' }) state?: string;
 @NoSsn() @text() @IsString() @MinLength(1, { message: 'Say what happened in a line.' }) @MaxLength(200) summary!: string;
 @NoSsn() @text() @IsOptional() @IsString() @ValidateIf(filled) @MaxLength(1000) note?: string;
 // Accidents (preventability starts undetermined unless Safety already decided).
 @ValidateIf(only('ACCIDENT')) @IsIn(['YES', 'NO', 'UNDETERMINED']) preventable?: 'YES' | 'NO' | 'UNDETERMINED';
 @ValidateIf(only('ACCIDENT')) @IsBoolean() injuries?: boolean;
 @ValidateIf(only('ACCIDENT')) @IsBoolean() fatalities?: boolean;
 @ValidateIf(only('ACCIDENT')) @IsBoolean() towAway?: boolean;
 // Violations.
 @ValidateIf(only('VIOLATION')) @IsIn(['PENDING', 'CONVICTED', 'DISMISSED']) disposition?: 'PENDING' | 'CONVICTED' | 'DISMISSED';
 // Inspections.
 @ValidateIf(only('INSPECTION')) @IsBoolean() outOfService?: boolean;
 @ValidateIf(only('INSPECTION')) @IsInt() @Min(0) @Max(50) violationCount?: number;
}
/** Settles an accident's preventability or a pending violation's outcome, once. */
export class SettleIncidentDto {
 @IsInt() @Min(1) version!: number;
 @IsOptional() @IsIn(['YES', 'NO']) preventable?: 'YES' | 'NO';
 @IsOptional() @IsIn(['CONVICTED', 'DISMISSED']) disposition?: 'CONVICTED' | 'DISMISSED';
}
export class VoidIncidentDto {
 @IsInt() @Min(1) version!: number;
 @NoSsn() @text() @IsString() @MinLength(1, { message: 'Say why this entry is being voided.' }) @MaxLength(500) reason!: string;
}
