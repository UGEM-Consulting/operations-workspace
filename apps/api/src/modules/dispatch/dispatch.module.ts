import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Roles } from '../auth/policy';
import { AuthRequest } from '../auth/session';
import { Role } from '../users/user.entity';
import { AddContactDto, CreateTeamDto, LeaveMemberDto, ReassignSupportDto, MoveMemberDto, StatusQueryDto, UpdateMemberDto, UpdateTeamDto } from './dispatch.dto';
import { DispatchService } from './dispatch.service';

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
@Module({ controllers: [DispatchController], providers: [DispatchService] })
export class DispatchModule {}
