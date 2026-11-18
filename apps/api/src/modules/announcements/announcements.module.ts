import { Body, Controller, Get, HttpCode, Module, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { Roles } from '../auth/policy';
import { AuthRequest } from '../auth/session';
import { NoSsn } from '../safety/pii';
import { UpdatesModule } from '../updates/updates.module';
import { Role } from '../users/user.entity';
import { ANNOUNCEMENT_MAX, AnnouncementsService } from './announcements.service';

const text = () => Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value);
class CreateAnnouncementDto {
 @IsArray() @ArrayMinSize(1, { message: 'Choose at least one team.' }) @ArrayMaxSize(200) @IsUUID('all', { each: true }) teamIds!: string[];
 @text() @IsString() @MaxLength(ANNOUNCEMENT_MAX, { message: 'An announcement is up to 1,000 characters.' }) @NoSsn() text!: string;
}
class TakeBackDto {
 @IsOptional() @text() @IsString() @MaxLength(500) @NoSsn() reason?: string;
}

/** Announcements to team groups (section 37). Managers and administrators for every team; a team lead for the teams they lead (checked in the service). */
@Controller('announcements')
@Roles(Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER, Role.TEAM_LEAD)
class AnnouncementsController {
 constructor(private readonly announcements: AnnouncementsService) {}
 @Get() list(@Req() req: AuthRequest) { return this.announcements.list(req.currentUser); }
 @Get('options') options(@Req() req: AuthRequest) { return this.announcements.options(req.currentUser); }
 @Get(':id') detail(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.announcements.detail(req.currentUser, id); }
 @Post() create(@Req() req: AuthRequest, @Body() dto: CreateAnnouncementDto) { return this.announcements.create(req.currentUser, dto.teamIds, dto.text); }
 @Post(':id/take-back') @HttpCode(200) takeBack(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TakeBackDto) { return this.announcements.takeBack(req.currentUser, id, dto.reason || null); }
}
@Module({ imports: [UpdatesModule], controllers: [AnnouncementsController], providers: [AnnouncementsService] })
export class AnnouncementsModule {}
