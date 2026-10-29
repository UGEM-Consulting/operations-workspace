import { EmailModule } from '../email/email.module';
import { StorageModule } from '../storage/storage.module';
import { clientContext } from '../documents/client-context';
import { ReviewService } from './review.service';
import { UpdatesModule } from '../updates/updates.module';
import { UpdatesService } from '../updates/updates.service';
import { DataSource } from 'typeorm';
import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { Roles, Public } from '../auth/policy';
import { AuthRequest } from '../auth/session';
import { Role } from '../users/user.entity';
import { ApplicationQueryDto, ReviewDto, BeginVerificationDto, CreateInvitationDto, DraftDto, SubmitDto, UpdatePreferencesDto, VerifyApplicantDto } from './dto';
import { OnboardingService } from './onboarding.service';
@Controller('onboarding')
@Roles(Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER)
class OnboardingController {
 constructor(private readonly service: OnboardingService, private readonly reviews: ReviewService) {}
 @Post('invitations') create(@Req() req: AuthRequest, @Body() dto: CreateInvitationDto) { return this.service.create(req.currentUser,dto); }
 @Get('invitations') invitations(@Req() req: AuthRequest) { return this.service.invitations(req.currentUser); }
 @Post('invitations/:id/revoke') revoke(@Req() req: AuthRequest,@Param('id',ParseUUIDPipe) id: string) { return this.service.revoke(req.currentUser,id); }
 @Get('applications') applications(@Req() req: AuthRequest) { return this.reviews.legacyList(req.currentUser); }
 @Get('summary') summary(@Req() req: AuthRequest) { return this.reviews.summary(req.currentUser); }
 @Get('review-queue') queue(@Req() req: AuthRequest, @Query() query: ApplicationQueryDto) { return this.reviews.queue(req.currentUser,query); }
 @Post('applications/:id/reviews') review(@Req() req: AuthRequest,@Param('id',ParseUUIDPipe) id: string,@Body() dto: ReviewDto) { return this.reviews.decide(req.currentUser,id,dto,clientContext(req)); }
 @Get('applications/:id') detail(@Req() req: AuthRequest,@Param('id',ParseUUIDPipe) id: string) { return this.reviews.detail(req.currentUser,id); }
}
// Public to the STAFF guard only. Each record operation verifies a restricted applicant session in the service.
// The shared BFF and CSRF boundary applies to every route, including verification.
@Controller('applicant')
@Public()
class ApplicantController {
 constructor(private readonly service: OnboardingService) {}
 @Post('begin') begin(@Body() dto: BeginVerificationDto,@Req() req: Request) { return this.service.begin(dto,req); }
 @Post('verify') verify(@Body() dto: VerifyApplicantDto,@Req() req: Request) { return this.service.verify(dto,req); }
 @Get('application') current(@Req() req: Request) { return this.service.current(req); }
 @Patch('draft') draft(@Body() dto: DraftDto,@Req() req: Request) { return this.service.save(req,dto,false); }
 @Post('submit') submit(@Body() dto: SubmitDto,@Req() req: Request) { return this.service.save(req,dto,true); }
 @Post('logout') async logout(@Req() req: Request) {
  await new Promise<void>((resolve,reject) => req.session.destroy(error => error ? reject(error) : resolve()));
  return { message: 'Signed out' };
 }
}
// How the applicant hears about decisions. Same applicant-session and BFF/CSRF boundary as the other applicant routes.
@Controller('applicant/updates')
@Public()
class ApplicantUpdatesController {
 constructor(private readonly db: DataSource, private readonly applicants: OnboardingService, private readonly updates: UpdatesService) {}
 @Get() async view(@Req() req: Request) { const {application} = await this.applicants.applicant(this.db.manager,req); return this.updates.view(this.db.manager,application.id); }
 @Patch() save(@Req() req: Request,@Body() dto: UpdatePreferencesDto) {
  return this.db.transaction(async em => { const {application,invitation} = await this.applicants.applicant(em,req,true); return this.updates.save(em,application,invitation,dto); });
 }
 @Post('telegram') async link(@Req() req: Request) { const {application} = await this.applicants.applicant(this.db.manager,req); return this.updates.connectLink(this.db.manager,application); }
 @Post('telegram/check') async check(@Req() req: Request) { const {application} = await this.applicants.applicant(this.db.manager,req); return this.updates.checkConnection(application); }
 @Post('telegram/disconnect') disconnect(@Req() req: Request) {
  return this.db.transaction(async em => { const {application,invitation} = await this.applicants.applicant(em,req,true); return this.updates.disconnect(em,application,invitation); });
 }
}
@Module({ imports: [EmailModule,StorageModule,UpdatesModule],controllers: [OnboardingController,ApplicantController,ApplicantUpdatesController], providers: [OnboardingService, ReviewService], exports: [OnboardingService, ReviewService] })
export class OnboardingModule {}
