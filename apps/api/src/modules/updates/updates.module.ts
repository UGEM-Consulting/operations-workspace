import { Body, Controller, Get, HttpCode, Module, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { Role } from '../users/user.entity';
import { Roles, STAFF } from '../auth/policy';
import { GROUP_PURPOSES, SEND_TO, type GroupPurpose, type SendTo } from './groups';
import { TelegramGroupsService } from './groups.service';
import { AuthRequest } from '../auth/session';
import { EmailModule } from '../email/email.module';
import { NotificationsService } from './notifications.service';
import { TelegramClient } from './telegram.client';
import { UpdatesService } from './updates.service';
/** Each staff member's own Telegram connection for workspace alerts (Account security). */
@Controller('staff/telegram')
@Roles(...STAFF)
class StaffTelegramController {
 constructor(private readonly notifications: NotificationsService) {}
 @Get() view(@Req() req: AuthRequest) { return this.notifications.telegramView(req.currentUser); }
 @Post('connect') @HttpCode(200) connect(@Req() req: AuthRequest) { return this.notifications.telegramConnectLink(req.currentUser); }
 @Post('check') @HttpCode(200) check(@Req() req: AuthRequest) { return this.notifications.telegramCheck(req.currentUser); }
 @Post('disconnect') @HttpCode(200) disconnect(@Req() req: AuthRequest) { return this.notifications.telegramDisconnect(req.currentUser); }
}
class GroupCodeDto {
 @IsIn(GROUP_PURPOSES) purpose!: GroupPurpose;
 @IsOptional() @IsUUID() teamId?: string;
}
class AlertRouteDto {
 @IsIn(SEND_TO) sendTo!: SendTo;
}
/** Admin › Telegram (section 34): linked groups and where each alert goes. Administrators only. */
@Controller('telegram')
@Roles(Role.SYSTEM_ADMIN)
class TelegramGroupsController {
 constructor(private readonly groups: TelegramGroupsService) {}
 @Get('groups') view() { return this.groups.view(); }
 @Post('groups/codes') code(@Req() req: AuthRequest, @Body() dto: GroupCodeDto) { return this.groups.createCode(req.currentUser, dto.purpose, dto.teamId ?? null); }
 @Post('groups/codes/:id/check') @HttpCode(200) check(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.groups.checkCode(req.currentUser, id); }
 @Post('groups/:id/unlink') @HttpCode(200) unlink(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.groups.unlink(req.currentUser, id); }
 @Post('groups/:id/test') @HttpCode(200) test(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.groups.test(req.currentUser, id); }
 @Patch('routes/:alert') route(@Req() req: AuthRequest, @Param('alert') alert: string, @Body() dto: AlertRouteDto) { return this.groups.setRoute(req.currentUser, alert, dto.sendTo); }
}
@Module({ imports: [EmailModule], controllers: [StaffTelegramController, TelegramGroupsController], providers: [UpdatesService, NotificationsService, TelegramClient, TelegramGroupsService], exports: [UpdatesService, NotificationsService, TelegramClient, TelegramGroupsService] })
export class UpdatesModule {}
