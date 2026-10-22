import { Controller, Get, Module, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { Roles } from '../auth/policy';
import { AuthRequest } from '../auth/session';
import { Role } from '../users/user.entity';
import { DemoEmailService } from './demo-email.service';
@Controller('demo-mailbox')
@Roles(Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER)
class DemoMailboxController {
  constructor(private readonly delivery: DemoEmailService) {}
  @Get() list(@Req() req: AuthRequest) { return this.delivery.mailbox(req.currentUser); }
  @Post(':id/reveal') reveal(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.delivery.reveal(req.currentUser, id); }
}
@Module({ providers: [DemoEmailService], controllers: [DemoMailboxController], exports: [DemoEmailService] })
export class DemoEmailModule {}
