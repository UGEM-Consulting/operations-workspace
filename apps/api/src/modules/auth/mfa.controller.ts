import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { Role } from '../users/user.entity';
import { MfaCodeDto, MfaPolicyDto } from './mfa.dto';
import { MfaService } from './mfa.service';
import { AllowPendingMfa, Roles, STAFF } from './policy';
import { AuthRequest } from './session';
@Controller()
export class MfaController {
  constructor(private readonly mfa: MfaService) {}
  // Second sign-in step: only a pending 'verify' session reaches it; the service re-reads that state.
  @Roles(...STAFF) @AllowPendingMfa('verify') @Post('auth/mfa/verify') @HttpCode(200)
  verify(@Body() input: MfaCodeDto, @Req() req: AuthRequest) { return this.mfa.verifyLogin(req, input.code); }
  // Enrolment: forced for required roles before any staff access, or voluntary from Account security.
  @Roles(...STAFF) @AllowPendingMfa('enrol') @Post('auth/mfa/enrolment') @HttpCode(200)
  beginEnrolment(@Req() req: AuthRequest) { return this.mfa.beginEnrolment(req.currentUser); }
  @Roles(...STAFF) @AllowPendingMfa('enrol') @Post('auth/mfa/enrolment/confirm') @HttpCode(200)
  confirmEnrolment(@Body() input: MfaCodeDto, @Req() req: AuthRequest) { return this.mfa.confirmEnrolment(req.currentUser, input.code, req); }
  @Roles(...STAFF) @Get('auth/mfa')
  status(@Req() req: AuthRequest) { return this.mfa.status(req.currentUser); }
  @Roles(...STAFF) @Post('auth/mfa/recovery-codes') @HttpCode(200)
  recoveryCodes(@Body() input: MfaCodeDto, @Req() req: AuthRequest) { return this.mfa.regenerateRecoveryCodes(req.currentUser, input.code); }
  @Roles(...STAFF) @Post('auth/mfa/disable') @HttpCode(200)
  disable(@Body() input: MfaCodeDto, @Req() req: AuthRequest) { return this.mfa.disable(req.currentUser, input.code, req); }
  @Roles(Role.SYSTEM_ADMIN) @Post('users/:id/mfa/reset') @HttpCode(200)
  reset(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthRequest) { return this.mfa.adminReset(req.currentUser, id); }
  @Roles(Role.SYSTEM_ADMIN) @Get('settings/security')
  policy() { return this.mfa.policy(); }
  @Roles(Role.SYSTEM_ADMIN) @Patch('settings/security')
  setPolicy(@Body() input: MfaPolicyDto, @Req() req: AuthRequest) { return this.mfa.setPolicy(req.currentUser, input.mfaRequiredFor); }
}
