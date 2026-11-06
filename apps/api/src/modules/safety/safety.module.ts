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
import { AssignOwnerDto, CreateDriverDto, MarkLeftDto, DriverQueryDto, ReopenDriverDto, UpdateDriverDto, WithdrawDriverDto } from './safety.dto';
import { DECIDERS, SAFETY_ROLES } from './driver-records';
import { SafetyService } from './safety.service';
import { AnnualReviewService } from './annual-review.service';
import { AnnualReviewDto } from './annual-review.dto';
import { TestingService } from './testing.service';
import { RecordTestDto, VoidTestDto } from './testing.dto';
import { IncidentService } from './incident.service';
import { TruckService } from './truck.service';
import { ArchiveTruckDto, OwnerDocumentDto, TruckDto } from './truck.dto';
import { RecordIncidentDto, SettleIncidentDto, VoidIncidentDto } from './incident.dto';
import { DecisionDto, RequestCorrectionsDto, ScreeningCheckDto, SendForDecisionDto, UploadMvrDto } from './screening.dto';
import { ScreeningService } from './screening.service';
import { ScanSweeper } from './scan-sweeper';
import { AddEmployerDto, ClearanceItemDto, UpdateEmployerDto } from './clearance.dto';
import { ClearanceService } from './clearance.service';
import { DriverSignedCopies } from './signed-copies';
import { ApplicantSignatureDto } from '../documents/documents.dto';
import { clientContext } from '../documents/client-context';
import { PublishConsentDto } from './consent.dto';
import { ConsentService } from './consent.service';
import { DocumentVersionDto, RenewalLinkDto, RenewDocumentDto } from './renewal.dto';
import { RenewalService } from './renewal.service';
import { NoticeLetterService, PublishNoticeLetterDto } from './notice-letters';
// Private files: never cached, never sniffed into another type.
const FileResponse = () => applyDecorators(Header('Cache-Control', 'no-store, private'), Header('X-Content-Type-Options', 'nosniff'));
const send = (file: FileResult) => new StreamableFile(file.body, { type: file.type, length: file.body.length, disposition: `inline; filename="${file.filename}"` });

// Every Safety role and administrators; the service decides who may change what.
@Controller('safety')
@Roles(...SAFETY_ROLES)
class SafetyController {
 constructor(private readonly safety: SafetyService, private readonly screening: ScreeningService, private readonly consents: ConsentService, private readonly clearance: ClearanceService, private readonly annual: AnnualReviewService, private readonly testing: TestingService, private readonly incidents: IncidentService, private readonly trucks: TruckService, private readonly renewals: RenewalService, private readonly letters: NoticeLetterService) {}
 // Consent forms: every Safety role reads them; the service lets only the Safety manager and administrators publish.
 // Consent forms and the notice letters, on one page (Forms and letters).
 @Get('consents') async consentList(@Req() req: AuthRequest) {
  const [consents, letters] = await Promise.all([this.consents.list(req.currentUser), this.letters.list()]);
  return { ...consents, letters };
 }
 // Notice letters: the Safety manager publishes them; a driver's letter is filled in on download and never stored.
 @Post('letters') publishLetter(@Req() req: AuthRequest, @Body() dto: PublishNoticeLetterDto) { return this.letters.publish(req.currentUser, dto); }
 @Get('letters/:id/file') @FileResponse() async letterFile(@Param('id', ParseUUIDPipe) id: string) { return send(await this.letters.file(id)); }
 @Get('drivers/:id/letters/:kind') @FileResponse() async driverLetter(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('kind') kind: string) { return send(await this.letters.forDriver(req.currentUser, id, kind)); }
 @Post('consents') publishConsent(@Req() req: AuthRequest, @Body() dto: PublishConsentDto) { return this.consents.publish(req.currentUser, dto); }
 @Get('consents/:id/file') @FileResponse() async consentFile(@Param('id', ParseUUIDPipe) id: string) { return send(await this.consents.staffFile(id)); }
 @Get('drivers/:id/consents/:documentId/signed') @FileResponse() async signedConsent(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('documentId', ParseUUIDPipe) documentId: string) { return send(await this.consents.staffSignedCopy(req.currentUser, id, documentId)); }
 // Verified scans that have expired or expire soon (dates only).
 @Get('expiring') expiring() { return this.safety.expiring(); }
 @Get('people') people() { return this.safety.people(); }
 @Get('drivers') drivers(@Query() query: DriverQueryDto) { return this.safety.drivers(query.status); }
 @Post('drivers') create(@Req() req: AuthRequest, @Body() dto: CreateDriverDto) { return this.safety.create(req.currentUser, dto); }
 // The record plus its yearly reviews, tests (only for those who may see results), incidents, trucks and any hold.
 @Get('drivers/:id') async driver(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) {
  const driver = await this.safety.driver(id);
  const [annualReviews, { testing, hold }, incidents, trucks, noticeLetters] = await Promise.all([this.annual.forDriver(id, driver.clearedAt), this.testing.forProfile(req.currentUser, id),
   this.incidents.forDriver(id), this.trucks.forDriver(id), DECIDERS.includes(req.currentUser.role) ? this.letters.current() : undefined]);
  return { ...driver, annualReviews, testing, incidents, trucks, hold, noticeLetters };
 }
 // Owner-operators' trucks and their lease, insurance and registration PDFs (no-store files; every open is recorded).
 @Get('trucks') truckList() { return this.trucks.list(); }
 @Post('drivers/:id/trucks') addTruck(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TruckDto) { return this.trucks.add(req.currentUser, id, dto); }
 @Post('drivers/:id/trucks/:truckId') updateTruck(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('truckId', ParseUUIDPipe) truckId: string, @Body() dto: TruckDto) { return this.trucks.update(req.currentUser, id, truckId, dto); }
 @Post('drivers/:id/trucks/:truckId/archive') archiveTruck(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('truckId', ParseUUIDPipe) truckId: string, @Body() dto: ArchiveTruckDto) { return this.trucks.archive(req.currentUser, id, truckId, dto); }
 @Post('drivers/:id/trucks/:truckId/documents') uploadOwnerDocument(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('truckId', ParseUUIDPipe) truckId: string, @Body() dto: OwnerDocumentDto) { return this.trucks.upload(req.currentUser, id, truckId, dto); }
 @Get('drivers/:id/trucks/:truckId/documents/:documentId/file') @FileResponse() async ownerDocument(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('truckId', ParseUUIDPipe) truckId: string, @Param('documentId', ParseUUIDPipe) documentId: string) { return send(await this.trucks.file(req.currentUser, id, truckId, documentId)); }
 // Yearly reviews due or overdue (and drivers found not qualified), open test results (only as this person may see them) and open incidents.
 @Get('due') async due(@Req() req: AuthRequest) { return { ...await this.annual.due(), tests: await this.testing.attentionFor(req.currentUser), incidents: await this.incidents.attention() }; }
 // Drug and alcohol test results (results only): the owner and Safety manager record; only the manager voids.
 @Post('drivers/:id/tests') recordTest(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RecordTestDto) { return this.testing.record(req.currentUser, id, dto); }
 // Accidents, violations and inspections: recorded by the owner or Safety manager; only the manager voids.
 @Post('drivers/:id/incidents') recordIncident(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RecordIncidentDto) { return this.incidents.record(req.currentUser, id, dto); }
 @Post('drivers/:id/incidents/:incidentId/settle') settleIncident(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('incidentId', ParseUUIDPipe) incidentId: string, @Body() dto: SettleIncidentDto) { return this.incidents.settle(req.currentUser, id, incidentId, dto); }
 @Post('drivers/:id/incidents/:incidentId/void') voidIncident(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('incidentId', ParseUUIDPipe) incidentId: string, @Body() dto: VoidIncidentDto) { return this.incidents.void(req.currentUser, id, incidentId, dto); }
 @Post('drivers/:id/tests/:testId/void') voidTest(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('testId', ParseUUIDPipe) testId: string, @Body() dto: VoidTestDto) { return this.testing.void(req.currentUser, id, testId, dto); }
 @Post('drivers/:id/annual-reviews') annualReview(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AnnualReviewDto) { return this.annual.record(req.currentUser, id, dto); }
 @Patch('drivers/:id') update(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDriverDto) { return this.safety.update(req.currentUser, id, dto); }
 @Post('drivers/:id/withdraw') withdraw(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: WithdrawDriverDto) { return this.safety.withdraw(req.currentUser, id, dto); }
 @Post('drivers/:id/reopen') reopen(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReopenDriverDto) { return this.safety.reopen(req.currentUser, id, dto); }
 @Post('drivers/:id/left') markLeft(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MarkLeftDto) { return this.safety.markLeft(req.currentUser, id, dto); }
 @Post('drivers/:id/owner') assignOwner(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignOwnerDto) { return this.safety.assignOwner(req.currentUser, id, dto); }
 @Post('drivers/:id/link') sendLink(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DriverVersionDto) { return this.safety.sendLink(req.currentUser, id, dto); }
 @Post('drivers/:id/link/cancel') cancelLink(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DriverVersionDto) { return this.safety.cancelLink(req.currentUser, id, dto); }
 // Scans are no-store files; every staff view is recorded.
 @Get('drivers/:id/documents/:documentId/file') @FileResponse() async document(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('documentId', ParseUUIDPipe) documentId: string) { return send(await this.safety.documentFile(req.currentUser, id, documentId)); }
 // Renewing a license or medical card: upload it checked, or send the driver a link to scan it (shown once), then check
 // their scan through verify or mark it as not readable.
 @Post('drivers/:id/documents/renew') renew(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RenewDocumentDto) { return this.renewals.upload(req.currentUser, id, dto); }
 @Post('drivers/:id/renewals') renewalLink(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RenewalLinkDto) { return this.renewals.sendLink(req.currentUser, id, dto); }
 @Post('drivers/:id/renewals/cancel') cancelRenewal(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RenewalLinkDto) { return this.renewals.cancelLink(req.currentUser, id, dto); }
 @Post('drivers/:id/documents/:documentId/unreadable') unreadable(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('documentId', ParseUUIDPipe) documentId: string, @Body() dto: DocumentVersionDto) { return this.renewals.unreadable(req.currentUser, id, documentId, dto); }
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
 // Clearance of an approved driver: the owner, the Safety manager and administrators (checked in the service).
 @Post('drivers/:id/clearance/:key') clearanceItem(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('key') key: string, @Body() dto: ClearanceItemDto) { return this.clearance.setItem(req.currentUser, id, key, dto); }
 @Post('drivers/:id/employers') addEmployer(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddEmployerDto) { return this.clearance.addEmployer(req.currentUser, id, dto); }
 @Post('drivers/:id/employers/:employerId') updateEmployer(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('employerId', ParseUUIDPipe) employerId: string, @Body() dto: UpdateEmployerDto) { return this.clearance.updateEmployer(req.currentUser, id, employerId, dto); }
 @Post('drivers/:id/employers/:employerId/remove') removeEmployer(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('employerId', ParseUUIDPipe) employerId: string, @Body() dto: DriverVersionDto) { return this.clearance.removeEmployer(req.currentUser, id, employerId, dto); }
 @Post('drivers/:id/clear') clear(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DriverVersionDto) { return this.clearance.clear(req.currentUser, id, dto); }
}
// Public to the STAFF guard only: the driver has no account. Each record operation checks the driver session (bound to an
// open link) in the service, and the shared BFF and CSRF boundary applies to every route, including verification.
@Controller('driver')
@Public()
class DriverController {
 constructor(private readonly access: DriverAccessService, private readonly consents: ConsentService, private readonly renewals: RenewalService) {}
 // A renewal link opens only this: which document Safety asked for, and sending its scan.
 @Get('renewal') renewal(@Req() req: Request) { return this.renewals.view(req); }
 @Post('renewal') sendRenewal(@Body() dto: DriverDocumentDto, @Req() req: Request) { return this.renewals.send(req, dto); }
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
@Module({ imports: [EmailModule, StorageModule], controllers: [SafetyController, DriverController], providers: [SafetyService, RenewalService, NoticeLetterService, AnnualReviewService, TestingService, IncidentService, TruckService, ScreeningService, ConsentService, ClearanceService, DriverAccessService, PiiService, ScanSweeper, DriverSignedCopies], exports: [ScreeningService, SafetyService, AnnualReviewService, TestingService, IncidentService, TruckService] })
export class SafetyModule {}
