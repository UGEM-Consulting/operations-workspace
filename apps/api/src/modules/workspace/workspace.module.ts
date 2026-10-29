import { Controller, Get, Module, Req } from '@nestjs/common';
import { Roles, STAFF } from '../auth/policy';
import { AuthRequest } from '../auth/session';
import { ItModule } from '../it/it.module';
import { ItService } from '../it/it.service';
import { OnboardingModule } from '../onboarding/onboarding.module';
import { ReviewService } from '../onboarding/review.service';
import { Role } from '../users/user.entity';
import { DispatchModule } from '../dispatch/dispatch.module';
import { PromotionsService } from '../dispatch/promotions.service';

/**
 * Work waiting for the signed-in person, for the sidebar and the notification bell. Each count reuses its feature's own
 * scoping (assigned applications, approved IT requests, own notifications); roles without access get no entry.
 */
@Controller('workspace')
@Roles(...STAFF)
class WorkspaceController {
  constructor(private readonly reviews: ReviewService, private readonly it: ItService, private readonly promotions: PromotionsService) {}
  @Get('counts')
  async counts(@Req() req: AuthRequest) {
    const user = req.currentUser;
    const reviewer = [Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER].includes(user.role);
    const itStaff = [Role.SYSTEM_ADMIN, Role.IT_SPECIALIST].includes(user.role);
    const [summary, openIt, unread, promotions] = await Promise.all([reviewer ? this.reviews.summary(user) : null, itStaff ? this.it.openCount(user) : null, reviewer ? this.it.unreadCount(user) : null, reviewer ? this.promotions.pendingCount() : null]);
    const navigation: Record<string, number> = {};
    if (summary) navigation.applications = summary.awaitingReview;
    if (openIt !== null) navigation.it = openIt;
    if (promotions !== null) navigation.promotions = promotions;
    return { navigation, unreadNotifications: unread };
  }
}
@Module({ imports: [OnboardingModule, ItModule, DispatchModule], controllers: [WorkspaceController] })
export class WorkspaceModule {}
