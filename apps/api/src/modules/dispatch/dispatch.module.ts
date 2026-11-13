import { Body, Controller, Get, Header, Module, Param, ParseUUIDPipe, Patch, Post, Query, Req, StreamableFile } from '@nestjs/common';
import { Roles } from '../auth/policy';
import { AuthRequest } from '../auth/session';
import { Role } from '../users/user.entity';
import { AskItDto, PlaceMemberDto, StartDateDto, SupportTypeDto, AddContactDto, AssignDriverDto, BackOnDto, CorrectDetailsDto, PaperScanDto, LeaveDto, LeaveReasonDto, LeaveVersionDto, CatchUpLinksDto, CloseAccountsDto, ExistingRowsDto, LeftDayDto, MemberNamesDto, UpdateExistingDto, ChangeLastDayDto, NoticeActionDto, CreatePromotionDto, CreateTeamDto, DecidePromotionDto, LeaveMemberDto, PromotionQueryDto, ReassignSupportDto, MoveMemberDto, StatusQueryDto, UpdateMemberDto, UpdateTeamDto, MemberListQueryDto, MemberExportDto } from './dispatch.dto';
import { DriverAssignmentsService } from './driver-assignments.service';
import { DispatchService } from './dispatch.service';
import { MemberListService } from './member-list';
import { ExistingDispatchersService } from './existing.service';
import { PromotionsService } from './promotions.service';
import { UpdatesModule } from '../updates/updates.module';
import { LeavingSweeper } from './leaving-sweeper';
import { LeaveService } from './leave.service';
import { MemberDetailsService } from './corrections';
import { PaperScansService } from './paper-scans';
import { StorageModule } from '../storage/storage.module';

@Controller('dispatch')
@Roles(Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER)
class DispatchController {
 constructor(private readonly dispatch: DispatchService, private readonly list: MemberListService) {}
 @Get('teams') teams(@Query() query: StatusQueryDto) { return this.dispatch.teams(query.status === 'LEFT' || query.status === 'ONBOARDING' || query.status === 'ON_LEAVE' ? 'ALL' : query.status); }
 @Get('teams/:id') team(@Param('id', ParseUUIDPipe) id: string) { return this.dispatch.team(id); }
 @Post('teams') createTeam(@Req() req: AuthRequest, @Body() dto: CreateTeamDto) { return this.dispatch.createTeam(req.currentUser, dto); }
 @Patch('teams/:id') updateTeam(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTeamDto) { return this.dispatch.updateTeam(req.currentUser, id, dto); }
 // An older web asks for everything with at most a status; the Dispatchers page asks for a page with filters.
 @Get('members') members(@Query() query: MemberListQueryDto) {
  const paged = Object.entries(query).some(([key, value]) => key !== 'status' && value !== undefined);
  if (paged || query.status === 'LEAVING' || query.status === 'MISSING') return this.list.list(query);
  return this.dispatch.members(query.status === undefined || query.status === 'ARCHIVED' ? 'ALL' : query.status);
 }
 // Export the view on screen: a POST, because it is recorded; rate-limited, work details only.
 @Post('members/export') exportMembers(@Req() req: AuthRequest, @Body() dto: MemberExportDto) { return this.list.export(req.currentUser, dto); }
 @Get('members/:id') member(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.dispatch.member(req.currentUser, id); }
 @Post('members/:id/contacts') addContact(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddContactDto) { return this.dispatch.addContact(req.currentUser, id, dto); }
 @Post('members/:id/contacts/:contactId/remove') removeContact(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('contactId', ParseUUIDPipe) contactId: string) { return this.dispatch.removeContact(req.currentUser, id, contactId); }
 @Patch('members/:id') updateMember(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateMemberDto) { return this.dispatch.updateMember(req.currentUser, id, dto); }
 @Post('members/:id/it-setup') askIt(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AskItDto) { return this.dispatch.askIt(req.currentUser, id, dto); }
 @Post('members/:id/support-type') supportType(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SupportTypeDto) { return this.dispatch.setSupportType(req.currentUser, id, dto); }
 @Post('members/:id/place') place(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PlaceMemberDto) { return this.dispatch.placeMember(req.currentUser, id, dto); }
 @Post('members/:id/start-date') startDate(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: StartDateDto) { return this.dispatch.setStartDate(req.currentUser, id, dto); }
 @Post('members/:id/move') move(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MoveMemberDto) { return this.dispatch.move(req.currentUser, id, dto); }
 @Post('members/:id/reassign') reassign(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReassignSupportDto) { return this.dispatch.reassignSupport(req.currentUser, id, dto); }
 @Post('members/:id/leave') leave(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: LeaveMemberDto) { return this.dispatch.leave(req.currentUser, id, dto); }
 @Post('members/:id/last-day') changeLastDay(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ChangeLastDayDto) { return this.dispatch.changeLastDay(req.currentUser, id, dto); }
 @Post('members/:id/cancel-notice') cancelNotice(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: NoticeActionDto) { return this.dispatch.cancelNotice(req.currentUser, id, dto); }
 @Post('members/:id/remove-access') removeAccess(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: NoticeActionDto) { return this.dispatch.removeAccessNow(req.currentUser, id, dto); }
}
// Leave (section 35) and an administrator's corrections (section 36). Who may correct is checked in the service.
@Controller('dispatch/members')
@Roles(Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER)
class LeaveController {
 constructor(private readonly leaves: LeaveService, private readonly details: MemberDetailsService) {}
 @Post(':id/on-leave') put(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: LeaveDto) { return this.leaves.put(req.currentUser, id, dto); }
 @Post(':id/on-leave/return') back(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: LeaveVersionDto) { return this.leaves.recordReturn(req.currentUser, id, dto); }
 @Post(':id/on-leave/cancel') cancel(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: LeaveVersionDto) { return this.leaves.cancel(req.currentUser, id, dto); }
 @Post(':id/on-leave/back-on') backOn(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: BackOnDto) { return this.leaves.changeBackOn(req.currentUser, id, dto); }
 @Post(':id/on-leave/reason') reason(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: LeaveReasonDto) { return this.leaves.changeReason(req.currentUser, id, dto); }
 @Post(':id/correct') correct(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CorrectDetailsDto) { return this.details.correct(req.currentUser, id, dto); }
}
// Cleared drivers: dispatch managers and administrators assign any of them to an MC and a dispatcher.
@Controller('dispatch')
@Roles(Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER)
class ExistingDispatchersController {
 constructor(private readonly existing: ExistingDispatchersService) {}
 @Get('existing/options') options() { return this.existing.options(); }
 @Post('existing/check') check(@Body() dto: ExistingRowsDto) { return this.existing.check(dto.rows); }
 @Post('existing/add') add(@Req() req: AuthRequest, @Body() dto: ExistingRowsDto) { return this.existing.add(req.currentUser, dto.rows, dto.sourceName); }
 @Get('paperwork') paperwork(@Req() req: AuthRequest) { return this.existing.paperwork(req.currentUser); }
 @Post('paperwork/links') links(@Req() req: AuthRequest, @Body() dto: CatchUpLinksDto) { return this.existing.links(req.currentUser, dto.memberIds); }
 @Post('members/:id/more-time') moreTime(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.existing.moreTime(req.currentUser, id); }
 @Patch('members/:id/existing') update(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateExistingDto) { return this.existing.update(req.currentUser, id, dto); }
 // People who left and other names (section 33).
 @Post('members/:id/left-day') leftDay(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: LeftDayDto) { return this.existing.recordLeftDay(req.currentUser, id, dto); }
 @Post('members/:id/close-accounts') closeAccounts(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CloseAccountsDto) { return this.existing.closeAccounts(req.currentUser, id, dto); }
 @Post('members/:id/names') names(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MemberNamesDto) { return this.existing.setNames(req.currentUser, id, dto); }
}
// Scans of an NDA or SOP signed on paper (section 38): added by any dispatch manager or administrator, opened as private files.
@Controller('dispatch/members')
@Roles(Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER)
class PaperScansController {
 constructor(private readonly scans: PaperScansService) {}
 @Post(':id/paper-scans') add(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PaperScanDto) { return this.scans.upload(req.currentUser, id, dto); }
 @Get(':id/paper-scans/:scanId/file') @Header('Cache-Control', 'no-store, private') @Header('X-Content-Type-Options', 'nosniff')
 async file(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('scanId', ParseUUIDPipe) scanId: string) {
  const file = await this.scans.file(req.currentUser, id, scanId);
  return new StreamableFile(file.body, { type: file.type, length: file.body.length, disposition: `inline; filename="${file.filename}"` });
 }
}
@Controller('dispatch/drivers')
@Roles(Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER)
class DispatchDriversController {
 constructor(private readonly drivers: DriverAssignmentsService) {}
 @Get() list() { return this.drivers.drivers(null); }
 @Get('options') options() { return this.drivers.options(null); }
 @Post(':id/assign') assign(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignDriverDto) { return this.drivers.assign(req.currentUser, false, id, dto); }
}
// Promotion decisions for dispatch managers and administrators.
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
@Module({ imports: [UpdatesModule, StorageModule], controllers: [DispatchController, LeaveController, ExistingDispatchersController, PaperScansController, DispatchDriversController, PromotionsController, TeamLeadController], providers: [DispatchService, MemberListService, LeaveService, MemberDetailsService, ExistingDispatchersService, PaperScansService, PromotionsService, DriverAssignmentsService, LeavingSweeper], exports: [PromotionsService] })
export class DispatchModule {}
