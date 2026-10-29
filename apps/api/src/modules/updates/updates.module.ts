import { Controller, Get, HttpCode, Module, Post, Req } from '@nestjs/common';
import { Roles, STAFF } from '../auth/policy';
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
@Module({ imports: [EmailModule], controllers: [StaffTelegramController], providers: [UpdatesService, NotificationsService, TelegramClient], exports: [UpdatesService, NotificationsService] })
export class UpdatesModule {}
