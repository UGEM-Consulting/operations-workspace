import { applyDecorators, Body, Controller, Get, Header, Module, Param, ParseUUIDPipe, Post, Req, StreamableFile } from '@nestjs/common';
import { Request } from 'express';
import { Public, Roles } from '../auth/policy';
import { AuthRequest } from '../auth/session';
import { OnboardingModule } from '../onboarding/onboarding.module';
import { StorageModule } from '../storage/storage.module';
import { Role } from '../users/user.entity';
import { clientContext } from './client-context';
import { DataSource } from 'typeorm';
import { ApplicantSignatureDto, PhotoDto, PublishDocumentDto, SaveSignatureDto } from './documents.dto';
import { deleteSignature, savedSignature, saveSignature } from './saved-signature';
import { DocumentsService, FileResult, photoKindParam } from './documents.service';
// Private files: never cached, never sniffed into another type.
const FileResponse = () => applyDecorators(Header('Cache-Control', 'no-store, private'), Header('X-Content-Type-Options', 'nosniff'));
const send = (file: FileResult) => new StreamableFile(file.body, { type: file.type, length: file.body.length, disposition: `inline; filename="${file.filename}"` });
@Controller('documents')
@Roles(Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER)
class CompanyDocumentsController {
 constructor(private readonly service: DocumentsService) {}
 @Get() list(@Req() req: AuthRequest) { return this.service.list(req.currentUser); }
 @Post() publish(@Req() req: AuthRequest, @Body() dto: PublishDocumentDto) { return this.service.publish(req.currentUser, dto); }
 @Get(':id/file') @FileResponse() async file(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return send(await this.service.companyFile(req.currentUser, id)); }
}
// The signed-in approver's own saved countersigning signature; never another user's.
@Controller('staff/signature')
@Roles(Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER)
class SavedSignatureController {
 constructor(private readonly db: DataSource) {}
 @Get() get(@Req() req: AuthRequest) { return savedSignature(this.db, req.currentUser); }
 @Post() save(@Req() req: AuthRequest, @Body() dto: SaveSignatureDto) { return saveSignature(this.db, req.currentUser, dto); }
 @Post('delete') remove(@Req() req: AuthRequest) { return deleteSignature(this.db, req.currentUser); }
}
@Controller('onboarding/applications')
@Roles(Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER)
class ApplicationFilesController {
 constructor(private readonly service: DocumentsService) {}
 @Get(':id/photos/:kind') @FileResponse() async photo(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('kind') kind: string) { return send(await this.service.staffPhoto(req.currentUser, id, photoKindParam(kind))); }
 @Get(':id/documents/:documentId/signed') @FileResponse() async signed(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('documentId', ParseUUIDPipe) documentId: string) { return send(await this.service.staffSignedCopy(req.currentUser, id, documentId)); }
}
@Controller('it/onboarding')
@Roles(Role.SYSTEM_ADMIN, Role.IT_SPECIALIST)
class ItPhotoController {
 constructor(private readonly service: DocumentsService) {}
 @Get(':id/photo') @FileResponse() async photo(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return send(await this.service.itPhoto(req.currentUser, id)); }
}
// Public to the STAFF guard only. Every service method verifies the restricted applicant session and record.
@Controller('applicant')
@Public()
class ApplicantDocumentsController {
 constructor(private readonly service: DocumentsService) {}
 @Post('photos/:kind') upload(@Req() req: Request, @Param('kind') kind: string, @Body() dto: PhotoDto) { return this.service.uploadPhoto(req, photoKindParam(kind), dto); }
 @Get('photos/:kind') @FileResponse() async photo(@Req() req: Request, @Param('kind') kind: string) { return send(await this.service.applicantPhoto(req, photoKindParam(kind))); }
 @Get('documents/:id/file') @FileResponse() async file(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) { return send(await this.service.applicantDocument(req, id)); }
 @Post('documents/:id/view') view(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) { return this.service.recordView(req, id); }
 @Post('documents/:id/sign') sign(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ApplicantSignatureDto) { return this.service.sign(req, id, dto, clientContext(req)); }
 @Get('documents/:id/signed') @FileResponse() async signed(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) { return send(await this.service.applicantSignedCopy(req, id)); }
}
@Module({ imports: [StorageModule, OnboardingModule], controllers: [CompanyDocumentsController, SavedSignatureController, ApplicationFilesController, ItPhotoController, ApplicantDocumentsController], providers: [DocumentsService] })
export class DocumentsModule {}
