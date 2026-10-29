import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Roles } from '../auth/policy';
import { AuthRequest } from '../auth/session';
import { Role } from '../users/user.entity';
import { AddContactDto, CreatePromotionDto, CreateTeamDto, DecidePromotionDto, LeaveMemberDto, PromotionQueryDto, ReassignSupportDto, MoveMemberDto, StatusQueryDto, UpdateMemberDto, UpdateTeamDto } from './dispatch.dto';
import { DispatchService } from './dispatch.service';
import { PromotionsService } from './promotions.service';
import { UpdatesModule } from '../updates/updates.module';

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
 constructor(private readonly promotions: PromotionsService) {}
 @Get() team(@Req() req: AuthRequest) { return this.promotions.team(req.currentUser); }
 @Post('promotions') async request(@Req() req: AuthRequest, @Body() dto: CreatePromotionDto) { await this.promotions.requireLead(req.currentUser); return this.promotions.request(req.currentUser, dto); }
 @Post('promotions/:id/cancel') cancel(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.promotions.cancel(req.currentUser, id); }
}
@Module({ imports: [UpdatesModule], controllers: [DispatchController, PromotionsController, TeamLeadController], providers: [DispatchService, PromotionsService], exports: [PromotionsService] })
export class DispatchModule {}
