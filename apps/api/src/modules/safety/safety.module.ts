import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Roles } from '../auth/policy';
import { AuthRequest } from '../auth/session';
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
}
@Module({ controllers: [SafetyController], providers: [SafetyService] })
export class SafetyModule {}
