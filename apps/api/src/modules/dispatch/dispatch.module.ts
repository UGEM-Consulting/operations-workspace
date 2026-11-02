import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Roles } from '../auth/policy';
import { AuthRequest } from '../auth/session';
import { Role } from '../users/user.entity';
import { AddContactDto, AssignDriverDto, ChangeLastDayDto, NoticeActionDto, CreatePromotionDto, CreateTeamDto, DecidePromotionDto, LeaveMemberDto, PromotionQueryDto, ReassignSupportDto, MoveMemberDto, StatusQueryDto, UpdateMemberDto, UpdateTeamDto } from './dispatch.dto';
import { DriverAssignmentsService } from './driver-assignments.service';
import { DispatchService } from './dispatch.service';
import { PromotionsService } from './promotions.service';
import { UpdatesModule } from '../updates/updates.module';
import { LeavingSweeper } from './leaving-sweeper';

@Controller('dispatch')
@Roles(Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER)
class DispatchController {
 constructor(private readonly dispatch: DispatchService) {}
 @Get('teams') teams(@Query() query: StatusQueryDto) { return this.dispatch.teams(query.status === 'LEFT' || query.status === 'ONBOARDING' ? 'ALL' : query.status); }
 @Post('teams') createTeam(@Req() req: AuthRequest, @Body() dto: CreateTeamDto) { return this.dispatch.createTeam(req.currentUser, dto); }
 @Patch('teams/:id') updateTeam(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTeamDto) { return this.dispatch.updateTeam(req.currentUser, id, dto); }
 @Get('members') members(@Query() query: StatusQueryDto) { return this.dispatch.members(query.status === 'ARCHIVED' ? 'ALL' : query.status); }
 @Get('members/:id') member(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.dispatch.member(req.currentUser, id); }
 @Post('members/:id/contacts') addContact(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddContactDto) { return this.dispatch.addContact(req.currentUser, id, dto); }
 @Post('members/:id/contacts/:contactId/remove') removeContact(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('contactId', ParseUUIDPipe) contactId: string) { return this.dispatch.removeContact(req.currentUser, id, contactId); }
 @Patch('members/:id') updateMember(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateMemberDto) { return this.dispatch.updateMember(req.currentUser, id, dto); }
 @Post('members/:id/move') move(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MoveMemberDto) { return this.dispatch.move(req.currentUser, id, dto); }
 @Post('members/:id/reassign') reassign(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReassignSupportDto) { return this.dispatch.reassignSupport(req.currentUser, id, dto); }
 @Post('members/:id/leave') leave(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: LeaveMemberDto) { return this.dispatch.leave(req.currentUser, id, dto); }
 @Post('members/:id/last-day') changeLastDay(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ChangeLastDayDto) { return this.dispatch.changeLastDay(req.currentUser, id, dto); }
 @Post('members/:id/cancel-notice') cancelNotice(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: NoticeActionDto) { return this.dispatch.cancelNotice(req.currentUser, id, dto); }
 @Post('members/:id/remove-access') removeAccess(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: NoticeActionDto) { return this.dispatch.removeAccessNow(req.currentUser, id, dto); }
}
// Cleared drivers: dispatcher managers and administrators assign any of them to an MC and a dispatcher.
@Controller('dispatch/drivers')
@Roles(Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER)
class DispatchDriversController {
 constructor(private readonly drivers: DriverAssignmentsService) {}
 @Get() list() { return this.drivers.drivers(null); }
 @Get('options') options() { return this.drivers.options(null); }
 @Post(':id/assign') assign(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignDriverDto) { return this.drivers.assign(req.currentUser, false, id, dto); }
}
// Promotion decisions for dispatcher managers and administrators.
@Controller('dispatch/promotions')
@Roles(Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER)
class PromotionsController {
 constructor(private readonly promotions: PromotionsService) {}
 @Get() list(@Query() query: PromotionQueryDto) { return this.promotions.list(query.status); }
 @Post(':id/decide') decide(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DecidePromotionDto) { return this.promotions.decide(req.currentUser, id, dto); }
}
// A team lead's own team: who is in it, and promotion requests for its supports.
@Controller('team')
@Roles(Role.TEAM_LEAD)
class TeamLeadController {
 constructor(private readonly promotions: PromotionsService, private readonly drivers: DriverAssignmentsService) {}
 @Get() team(@Req() req: AuthRequest) { return this.promotions.team(req.currentUser); }
 // Cleared drivers waiting for a dispatcher and the ones their teams work with; they assign inside their teams only.
 @Get('drivers') async teamDrivers(@Req() req: AuthRequest) { await this.promotions.requireLead(req.currentUser); return this.drivers.drivers(req.currentUser); }
 @Get('drivers/options') async teamOptions(@Req() req: AuthRequest) { await this.promotions.requireLead(req.currentUser); return this.drivers.options(req.currentUser); }
 @Post('drivers/:id/assign') assignDriver(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignDriverDto) { return this.drivers.assign(req.currentUser, true, id, dto); }
 @Post('promotions') async request(@Req() req: AuthRequest, @Body() dto: CreatePromotionDto) { await this.promotions.requireLead(req.currentUser); return this.promotions.request(req.currentUser, dto); }
 @Post('promotions/:id/cancel') cancel(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.promotions.cancel(req.currentUser, id); }
}
@Module({ imports: [UpdatesModule], controllers: [DispatchController, DispatchDriversController, PromotionsController, TeamLeadController], providers: [DispatchService, PromotionsService, DriverAssignmentsService, LeavingSweeper], exports: [PromotionsService] })
export class DispatchModule {}
