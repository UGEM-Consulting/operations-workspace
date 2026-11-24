import { applyDecorators, Controller, Get, Header, Module, Param, ParseUUIDPipe, Query, Req, StreamableFile } from '@nestjs/common';
import { Roles, STAFF } from '../auth/policy';
import { AuthRequest } from '../auth/session';
import { DispatchModule } from '../dispatch/dispatch.module';
import { DocumentsModule } from '../documents/documents.module';
import { SafetyModule } from '../safety/safety.module';
import type { FileResult } from '../documents/documents.service';
import { DispatchViewService } from './dispatch-view';
import { SafetyViewService } from './safety-view';
import { ViewMembersQueryDto } from './view.dto';

const FileResponse = () => applyDecorators(Header('Cache-Control', 'no-store, private'), Header('X-Content-Type-Options', 'nosniff'));
const send = (file: FileResult) => new StreamableFile(file.body, { type: file.type, length: file.body.length, disposition: `inline; filename="${file.filename}"` });

/**
 * View-only access (Design System section 39, approved 2026-11-20): read routes only, for anyone an administrator gave a
 * department to read. Every role may reach them; the services check the person's grant from PostgreSQL on every request
 * (requireView), and there is no write route here at all.
 */
@Controller('view')
@Roles(...STAFF)
class ViewController {
 constructor(private readonly dispatch: DispatchViewService, private readonly safety: SafetyViewService) {}
 @Get('dispatch/teams') teams(@Req() req: AuthRequest) { return this.dispatch.teams(req.currentUser); }
 @Get('dispatch/teams/:id') team(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.dispatch.team(req.currentUser, id); }
 @Get('dispatch/members') members(@Req() req: AuthRequest, @Query() query: ViewMembersQueryDto) { return this.dispatch.members(req.currentUser, query); }
 @Get('dispatch/members/:id') member(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.dispatch.member(req.currentUser, id); }
 @Get('dispatch/members/:id/documents/:documentId/signed') @FileResponse() async signed(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('documentId', ParseUUIDPipe) documentId: string) {
  return send(await this.dispatch.signedCopy(req.currentUser, id, documentId));
 }
 @Get('dispatch/members/:id/paper-scans/:scanId/file') @FileResponse() async scan(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('scanId', ParseUUIDPipe) scanId: string) {
  return send(await this.dispatch.paperScan(req.currentUser, id, scanId));
 }
 @Get('dispatch/drivers') dispatchDrivers(@Req() req: AuthRequest) { return this.dispatch.drivers(req.currentUser); }
 @Get('safety/drivers') drivers(@Req() req: AuthRequest) { return this.safety.drivers(req.currentUser); }
 @Get('safety/drivers/:id') driver(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.safety.driver(req.currentUser, id); }
 @Get('safety/drivers/:id/documents/:documentId/file') @FileResponse() async document(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('documentId', ParseUUIDPipe) documentId: string) {
  return send(await this.safety.document(req.currentUser, id, documentId));
 }
 @Get('safety/drivers/:id/consents/:documentId/signed') @FileResponse() async consent(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('documentId', ParseUUIDPipe) documentId: string) {
  return send(await this.safety.consent(req.currentUser, id, documentId));
 }
 @Get('safety/units') units(@Req() req: AuthRequest) { return this.safety.unitList(req.currentUser); }
 @Get('safety/units/:id/files/:fileId/file') @FileResponse() async unitFile(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('fileId', ParseUUIDPipe) fileId: string) {
  return send(await this.safety.unitFile(req.currentUser, id, fileId));
 }
 @Get('safety/expiring') expiring(@Req() req: AuthRequest) { return this.safety.expiring(req.currentUser); }
}

@Module({ imports: [DispatchModule, DocumentsModule, SafetyModule], controllers: [ViewController], providers: [DispatchViewService, SafetyViewService] })
export class ViewModule {}
