import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { Role } from '../users/user.entity';
import { MfaChallengeDto, MfaCodeDto, MfaEnrolmentDto, MfaPolicyDto } from './mfa.dto';
import { MfaService } from './mfa.service';
import { AllowPendingMfa, Roles, STAFF } from './policy';
import { AuthRequest } from './session';
@Controller()
export class MfaController {
  constructor(private readonly mfa: MfaService) {}
  // Second sign-in step: only a pending 'verify' session reaches it; the service re-reads that state.
  @Roles(...STAFF) @AllowPendingMfa('verify') @Post('auth/mfa/verify') @HttpCode(200)
  verify(@Body() input: MfaCodeDto, @Req() req: AuthRequest) { return this.mfa.verifyLogin(req, input.code); }
  // The sign-in step's method; for email codes it sends one (or a new one on resend, after a short wait).
  @Roles(...STAFF) @AllowPendingMfa('verify') @Post('auth/mfa/challenge') @HttpCode(200)
  challenge(@Body() input: MfaChallengeDto, @Req() req: AuthRequest) { return this.mfa.loginChallenge(req, !!input.resend); }
  // Methods this person may choose when setting up (administrators: authenticator only).
  @Roles(...STAFF) @AllowPendingMfa('enrol') @Get('auth/mfa/methods')
  methods(@Req() req: AuthRequest) { return this.mfa.methods(req); }
  // Enrolment: forced for required roles before any staff access, or voluntary from Account security. The service
  // re-reads which one this session is (a pending 'enrol' sign-in or a full session).
  @Roles(...STAFF) @AllowPendingMfa('enrol') @Post('auth/mfa/enrolment') @HttpCode(200)
  beginEnrolment(@Body() input: MfaEnrolmentDto, @Req() req: AuthRequest) { return this.mfa.beginEnrolment(req, input.method); }
  @Roles(...STAFF) @AllowPendingMfa('enrol') @Post('auth/mfa/enrolment/confirm') @HttpCode(200)
  confirmEnrolment(@Body() input: MfaCodeDto, @Req() req: AuthRequest) { return this.mfa.confirmEnrolment(req, input.code); }
  @Roles(...STAFF) @Get('auth/mfa')
  status(@Req() req: AuthRequest) { return this.mfa.status(req.currentUser); }
  // Email-code users confirm Account security changes with a code sent for that purpose.
  @Roles(...STAFF) @Post('auth/mfa/email-code') @HttpCode(200)
  manageCode(@Req() req: AuthRequest) { return this.mfa.sendManageCode(req.currentUser); }
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
