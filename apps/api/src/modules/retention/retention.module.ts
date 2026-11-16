import { Body, Controller, Get, HttpCode, Module, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, MinLength } from 'class-validator';
import { Roles } from '../auth/policy';
import { AuthRequest } from '../auth/session';
import { StorageModule } from '../storage/storage.module';
import { Role } from '../users/user.entity';
import { RetentionService } from './retention.service';
import { SUBJECTS, type Subject } from './rules';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
class DeletingDto { @IsBoolean() deleting!: boolean }
class HoldDto {
 @IsIn(SUBJECTS) subjectKind!: Subject;
 @IsUUID() subjectId!: string;
 @Matches(DAY, { message: 'Choose the day the hold ends.' }) until!: string;
 // Staff text; never health or other private details.
 @IsString() @MinLength(1, { message: 'Say why their records are held.' }) @MaxLength(500) reason!: string;
}
class ExtendHoldDto {
 @Matches(DAY, { message: 'Choose the day the hold ends.' }) until!: string;
 @IsString() @MinLength(1, { message: 'Say why the hold is longer.' }) @MaxLength(500) reason!: string;
}
class PageDto { @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number }
class PeopleDto { @IsString() @MaxLength(100) q!: string }

/** Admin › Keeping records (section 34). Administrators only. */
@Controller('retention')
@Roles(Role.SYSTEM_ADMIN)
class RetentionController {
 constructor(private readonly retention: RetentionService) {}
 @Get() overview() { return this.retention.overview(); }
 @Get('due') due(@Query() query: PageDto) { return this.retention.due(query.page ?? 1); }
 @Get('people') people(@Query() query: PeopleDto) { return this.retention.people(query.q); }
 @Get('runs') runs() { return this.retention.runs(); }
 @Post('settings') @HttpCode(200) settings(@Req() req: AuthRequest, @Body() dto: DeletingDto) { return this.retention.setDeleting(req.currentUser, dto.deleting); }
 @Post('holds') hold(@Req() req: AuthRequest, @Body() dto: HoldDto) { return this.retention.hold(req.currentUser, dto); }
 @Post('holds/:id/extend') @HttpCode(200) extend(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ExtendHoldDto) { return this.retention.extendHold(req.currentUser, id, dto); }
 @Post('holds/:id/end') @HttpCode(200) end(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.retention.endHold(req.currentUser, id); }
}
@Module({ imports: [StorageModule], controllers: [RetentionController], providers: [RetentionService], exports: [RetentionService] })
export class RetentionModule {}
