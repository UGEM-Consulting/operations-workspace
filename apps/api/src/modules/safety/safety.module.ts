import { applyDecorators, Body, Controller, Get, Header, Module, Param, ParseUUIDPipe, Patch, Post, Query, Req, StreamableFile } from '@nestjs/common';
import { Request } from 'express';
import { Public, Roles } from '../auth/policy';
import { AuthRequest } from '../auth/session';
import type { FileResult } from '../documents/documents.service';
import { EmailModule } from '../email/email.module';
import { StorageModule } from '../storage/storage.module';
import { BeginDriverDto, DriverDocumentDto, DriverVersionDto, SaveDriverApplicationDto, VerifyDocumentDto, VerifyDriverDto } from './driver-application.dto';
import { DriverAccessService } from './driver-access.service';
import { PiiService } from './pii';
import { AssignOwnerDto, CreateDriverDto, DriverQueryDto, ReopenDriverDto, UpdateDriverDto, WithdrawDriverDto } from './safety.dto';
import { SAFETY_ROLES } from './driver-records';
import { SafetyService } from './safety.service';
import { DecisionDto, RequestCorrectionsDto, ScreeningCheckDto, SendForDecisionDto, UploadMvrDto } from './screening.dto';
import { ScreeningService } from './screening.service';
import { ScanSweeper } from './scan-sweeper';
import { DriverSignedCopies } from './signed-copies';
import { ApplicantSignatureDto } from '../documents/documents.dto';
import { clientContext } from '../documents/client-context';
import { PublishConsentDto } from './consent.dto';
import { ConsentService } from './consent.service';
// Private files: never cached, never sniffed into another type.
const FileResponse = () => applyDecorators(Header('Cache-Control', 'no-store, private'), Header('X-Content-Type-Options', 'nosniff'));
const send = (file: FileResult) => new StreamableFile(file.body, { type: file.type, length: file.body.length, disposition: `inline; filename="${file.filename}"` });

// Every Safety role and administrators; the service decides who may change what.
@Controller('safety')
@Roles(...SAFETY_ROLES)
class SafetyController {
 constructor(private readonly safety: SafetyService, private readonly screening: ScreeningService, private readonly consents: ConsentService) {}
 // Consent forms: every Safety role reads them; the service lets only the Safety manager and administrators publish.
 @Get('consents') consentList(@Req() req: AuthRequest) { return this.consents.list(req.currentUser); }
 @Post('consents') publishConsent(@Req() req: AuthRequest, @Body() dto: PublishConsentDto) { return this.consents.publish(req.currentUser, dto); }
 @Get('consents/:id/file') @FileResponse() async consentFile(@Param('id', ParseUUIDPipe) id: string) { return send(await this.consents.staffFile(id)); }
 @Get('drivers/:id/consents/:documentId/signed') @FileResponse() async signedConsent(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('documentId', ParseUUIDPipe) documentId: string) { return send(await this.consents.staffSignedCopy(req.currentUser, id, documentId)); }
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
 // Scans are no-store files; every staff view is recorded.
 @Get('drivers/:id/documents/:documentId/file') @FileResponse() async document(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('documentId', ParseUUIDPipe) documentId: string) { return send(await this.safety.documentFile(req.currentUser, id, documentId)); }
 @Post('drivers/:id/documents/:documentId/verify') verify(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('documentId', ParseUUIDPipe) documentId: string, @Body() dto: VerifyDocumentDto) { return this.safety.verifyDocument(req.currentUser, id, documentId, dto); }
 // A POST so the full number never sits in a cacheable GET; every view is recorded.
 @Post('drivers/:id/ssn') ssn(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.safety.revealSsn(req.currentUser, id); }
 // Screening and the Safety manager's decision. The MVR is a no-store file; every view is recorded.
 @Post('drivers/:id/checks/:key') check(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('key') key: string, @Body() dto: ScreeningCheckDto) { return this.screening.setCheck(req.currentUser, id, key, dto); }
 @Post('drivers/:id/mvr') mvr(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UploadMvrDto) { return this.screening.uploadMvr(req.currentUser, id, dto); }
 @Get('drivers/:id/reports/:reportId/file') @FileResponse() async report(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('reportId', ParseUUIDPipe) reportId: string) { return send(await this.screening.reportFile(req.currentUser, id, reportId)); }
 @Post('drivers/:id/corrections') corrections(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RequestCorrectionsDto) { return this.screening.requestCorrections(req.currentUser, id, dto); }
 @Post('drivers/:id/send-for-decision') sendForDecision(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SendForDecisionDto) { return this.screening.sendForDecision(req.currentUser, id, dto); }
 @Post('drivers/:id/decision') decide(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DecisionDto) { return this.screening.decide(req.currentUser, id, dto); }
}
// Public to the STAFF guard only: the driver has no account. Each record operation checks the driver session (bound to an
// open link) in the service, and the shared BFF and CSRF boundary applies to every route, including verification.
@Controller('driver')
@Public()
class DriverController {
 constructor(private readonly access: DriverAccessService, private readonly consents: ConsentService) {}
 // Consent forms: open (recorded only by the explicit view request), sign, and download the signed copy.
 @Get('consents/:id/file') @FileResponse() async consentFile(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) { return send(await this.consents.driverFile(req, id)); }
 @Post('consents/:id/view') consentView(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) { return this.consents.recordView(req, id); }
 @Post('consents/:id/sign') consentSign(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ApplicantSignatureDto, @Req() req: Request) { return this.consents.sign(req, id, dto, clientContext(req)); }
 @Get('consents/:id/signed') @FileResponse() async consentSigned(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) { return send(await this.consents.driverSignedCopy(req, id)); }
 @Post('begin') begin(@Body() dto: BeginDriverDto, @Req() req: Request) { return this.access.begin(dto, req); }
 @Post('verify') verify(@Body() dto: VerifyDriverDto, @Req() req: Request) { return this.access.verify(dto, req); }
 @Get('application') current(@Req() req: Request) { return this.access.current(req); }
 @Patch('application') save(@Body() dto: SaveDriverApplicationDto, @Req() req: Request) { return this.access.save(req, dto, false); }
 @Post('documents/:kind') upload(@Body() dto: DriverDocumentDto, @Param('kind') kind: string, @Req() req: Request) { return this.access.uploadDocument(req, kind, dto); }
 @Get('documents/:id/file') @FileResponse() async document(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) { return send(await this.access.documentFile(req, id)); }
 @Post('application/submit') submit(@Body() dto: SaveDriverApplicationDto, @Req() req: Request) { return this.access.save(req, dto, true); }
 @Post('logout') async logout(@Req() req: Request) {
  await new Promise<void>((resolve, reject) => req.session.destroy(error => error ? reject(error) : resolve()));
  return { message: 'Signed out' };
 }
}
@Module({ imports: [EmailModule, StorageModule], controllers: [SafetyController, DriverController], providers: [SafetyService, ScreeningService, ConsentService, DriverAccessService, PiiService, ScanSweeper, DriverSignedCopies], exports: [ScreeningService] })
export class SafetyModule {}
