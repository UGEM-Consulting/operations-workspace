import { BeforeApplicationShutdown, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { DispatchService } from './dispatch.service';

const EVERY_MS = 10 * 60_000, FIRST_AFTER_MS = 60_000;

/**
 * Notice periods: on a timer, alerts IT when a scheduled removal falls due, and marks dispatchers as left once their last
 * day has passed and everyone is reassigned (so within minutes of the last reassignment). One instance runs at a time
 * (an advisory lock in DispatchService.sweepLeaving); a missed run is simply picked up by the next.
 */
@Injectable()
export class LeavingSweeper implements OnApplicationBootstrap, BeforeApplicationShutdown {
 private timers: NodeJS.Timeout[] = [];
 constructor(private readonly dispatch: DispatchService) {}
 onApplicationBootstrap() {
  const first = setTimeout(() => void this.run(), FIRST_AFTER_MS); first.unref();
  const every = setInterval(() => void this.run(), EVERY_MS); every.unref();
  this.timers = [first, every];
 }
 beforeApplicationShutdown() { for (const timer of this.timers) clearTimeout(timer); this.timers = []; }
 /** Never throws: the next run tries again. */
 run() { return this.dispatch.sweepLeaving().catch(() => ({ alerted: 0, left: 0, failed: 1 })); }
}
