import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { Public, Roles } from '../auth/policy';
import { AuthRequest } from '../auth/session';
import { EmailModule } from '../email/email.module';
import { BeginDriverDto, DriverVersionDto, SaveDriverApplicationDto, VerifyDriverDto } from './driver-application.dto';
import { DriverAccessService } from './driver-access.service';
import { PiiService } from './pii';
import { AssignOwnerDto, CreateDriverDto, DriverQueryDto, ReopenDriverDto, UpdateDriverDto, WithdrawDriverDto } from './safety.dto';
import { SAFETY_ROLES, SafetyService } from './safety.service';

// Every Safety role and administrators; the service decides who may change what.
@Controller('safety')
@Roles(...SAFETY_ROLES)
class SafetyController {
 constructor(private readonly safety: SafetyService) {}
 @Get('people') people() { return this.safety.people(); }
 @Get('drivers') drivers(@Query() query: DriverQueryDto) { return this.safety.drivers(query.status); }
 @Post('drivers') create(@Req() req: AuthRequest, @Body() dto: CreateDriverDto) { return this.safety.create(req.currentUser, dto); }
 @Get('drivers/:id') driver(@Param('id', ParseUUIDPipe) id: string) { return this.safety.driver(id); }
 @Patch('drivers/:id') update(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDriverDto) { return this.safety.update(req.currentUser, id, dto); }
 @Post('drivers/:id/withdraw') withdraw(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: WithdrawDriverDto) { return this.safety.withdraw(req.currentUser, id, dto); }
 @Post('drivers/:id/reopen') reopen(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReopenDriverDto) { return this.safety.reopen(req.currentUser, id, dto); }
 @Post('drivers/:id/owner') assignOwner(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignOwnerDto) { return this.safety.assignOwner(req.currentUser, id, dto); }
 @Post('drivers/:id/link') sendLink(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DriverVersionDto) { return this.safety.sendLink(req.currentUser, id, dto); }
 @Post('drivers/:id/link/cancel') cancelLink(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DriverVersionDto) { return this.safety.cancelLink(req.currentUser, id, dto); }
 // A POST so the full number never sits in a cacheable GET; every view is recorded.
 @Post('drivers/:id/ssn') ssn(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.safety.revealSsn(req.currentUser, id); }
}
// Public to the STAFF guard only: the driver has no account. Each record operation checks the driver session (bound to an
// open link) in the service, and the shared BFF and CSRF boundary applies to every route, including verification.
@Controller('driver')
@Public()
class DriverController {
 constructor(private readonly access: DriverAccessService) {}
 @Post('begin') begin(@Body() dto: BeginDriverDto, @Req() req: Request) { return this.access.begin(dto, req); }
 @Post('verify') verify(@Body() dto: VerifyDriverDto, @Req() req: Request) { return this.access.verify(dto, req); }
 @Get('application') current(@Req() req: Request) { return this.access.current(req); }
 @Patch('application') save(@Body() dto: SaveDriverApplicationDto, @Req() req: Request) { return this.access.save(req, dto, false); }
 @Post('application/submit') submit(@Body() dto: SaveDriverApplicationDto, @Req() req: Request) { return this.access.save(req, dto, true); }
 @Post('logout') async logout(@Req() req: Request) {
  await new Promise<void>((resolve, reject) => req.session.destroy(error => error ? reject(error) : resolve()));
  return { message: 'Signed out' };
 }
}
@Module({ imports: [EmailModule], controllers: [SafetyController, DriverController], providers: [SafetyService, DriverAccessService, PiiService] })
export class SafetyModule {}
