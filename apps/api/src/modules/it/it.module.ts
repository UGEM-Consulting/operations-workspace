import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Roles } from '../auth/policy';
import { AuthRequest } from '../auth/session';
import { Role } from '../users/user.entity';
import { ItContactDto, ItQueueDto, TaskUpdateDto } from './it.dto';
import { ItService } from './it.service';
@Controller('it/onboarding')
@Roles(Role.SYSTEM_ADMIN,Role.IT_SPECIALIST)
class ItController {
 constructor(private readonly service:ItService){}
 @Get() queue(@Req() req:AuthRequest,@Query() input:ItQueueDto){return this.service.queue(req.currentUser,input);}
 @Get(':id') get(@Req() req:AuthRequest,@Param('id',ParseUUIDPipe) id:string){return this.service.get(req.currentUser,id);}
 @Patch(':id/contact') contact(@Req() req:AuthRequest,@Param('id',ParseUUIDPipe) id:string,@Body() input:ItContactDto){return this.service.contact(req.currentUser,id,input);}
 @Patch(':id/tasks/:key') task(@Req() req:AuthRequest,@Param('id',ParseUUIDPipe) id:string,@Param('key') key:string,@Body() input:TaskUpdateDto){return this.service.task(req.currentUser,id,key,input);}
}
@Controller('notifications')
@Roles(Role.SYSTEM_ADMIN,Role.DISPATCHER_MANAGER)
class NotificationController {
 constructor(private readonly service:ItService){}
 @Get() list(@Req() req:AuthRequest){return this.service.notifications(req.currentUser);}
 @Post(':id/read') read(@Req() req:AuthRequest,@Param('id',ParseUUIDPipe) id:string){return this.service.readNotification(req.currentUser,id);}
}
@Module({controllers:[ItController,NotificationController],providers:[ItService]})
export class ItModule {}
