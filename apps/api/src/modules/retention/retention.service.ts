import { BadRequestException, BeforeApplicationShutdown, ConflictException, Injectable, Logger, NotFoundException, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { addDays, usDay } from '../safety/screening-rules';
import { StorageService } from '../storage/storage.service';
import type { User } from '../users/user.entity';
import { deleteApplication, deleteDriver, deleteInvitation, deleteMember, DELETED_FROM, KNOWN_REFERENCES } from './delete';
import { CANDIDATES_SQL, HOLD_MAX_DAYS, NOTICE_DAYS, RETENTION_KINDS, type RetentionKind, type Subject, WITH_HOLDS_SQL } from './rules';

// One API instance runs the weekly deletion at a time.
const RUN_LOCK = 42002042;
const CHECK_EVERY_MS = 60 * 60000, FIRST_AFTER_MS = 5 * 60000;
const PAGE_SIZE = 25;
interface Candidate { kind: RetentionKind; subject: Subject; id: string; name: string; detail: string; what: string; basis: string; basisOn: string; dueOn: string; holdId: string | null; heldUntil: string | null; holdReason: string | null }

/**
 * Keeping records (section 34, approved 2026-11-16). Administrators see the schedule, what is due and the log, hold a
 * person's records, and turn deleting on or off; each change is recorded. Deleting runs once a week (Mondays, US Eastern)
 * only while it's on, and never before 14 days after it was turned on, so everything deleted was listed first. Each record
 * goes in its own transaction with its files after; the log keeps counts only, never who.
 */
@Injectable()
export class RetentionService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('Retention');
  private timers: NodeJS.Timeout[] = [];
  constructor(private readonly db: DataSource, private readonly storage: StorageService) {}
  onApplicationBootstrap() {
    const first = setTimeout(() => void this.tick(), FIRST_AFTER_MS); first.unref();
    const every = setInterval(() => void this.tick(), CHECK_EVERY_MS); every.unref();
    this.timers = [first, every];
  }
  beforeApplicationShutdown() { for (const timer of this.timers) clearTimeout(timer); this.timers = []; }

  private async settings() {
    // The one row: made again if it is missing (a database restored without it), always off.
    await this.db.query(`INSERT INTO retention_settings (id) VALUES (1) ON CONFLICT DO NOTHING`);
    const [row]: { deleting: boolean; updatedAt: Date | null; updatedBy: string | null }[] = await this.db.query(`SELECT s.deleting, s."updatedAt", u."firstName" || ' ' || u."lastName" AS "updatedBy" FROM retention_settings s LEFT JOIN users u ON u.id = s."updatedBy" WHERE s.id = 1`);
    const since = row?.deleting && row.updatedAt ? usDay('latest', row.updatedAt) : null;
    return { deleting: !!row?.deleting, changedAt: row?.updatedAt ?? null, changedBy: row?.updatedBy ?? null, firstDeletion: since ? addDays(since, NOTICE_DAYS) : null };
  }
  private candidates(today: string): Promise<Candidate[]> { return this.db.query(`${WITH_HOLDS_SQL} ORDER BY c."dueOn", c.name`, [today]); }

  /** The schedule: each kind with how many are past it (and not held), what is due within 14 days, holds and the last run. */
  async overview() {
    const today = usDay('latest'), all = await this.candidates(today);
    const past = (kind: RetentionKind) => all.filter(item => item.kind === kind && !item.holdId && item.dueOn <= today).length;
    const [tests] = await this.db.query(`SELECT count(*)::integer AS n FROM driver_tests t JOIN drivers d ON d.id = t."driverId" WHERE d."closedAt" IS NOT NULL AND t."testedOn" + interval '5 years' <= $1::date`, [today]);
    const [last] = await this.db.query(`SELECT day::text AS day, "finishedAt" FROM retention_runs ORDER BY day DESC LIMIT 1`);
    const held = (await this.db.query(`SELECT count(*)::integer AS n FROM retention_holds WHERE "endedAt" IS NULL AND until >= $1::date`, [today]))[0].n as number;
    return { ...await this.settings(), today, noticeDays: NOTICE_DAYS,
      kinds: RETENTION_KINDS.map(item => ({ ...item, pastIt: item.kind === 'TESTS' ? tests.n as number : item.kind === 'FILES' ? 0 : past(item.kind) })),
      dueSoon: all.filter(item => !item.holdId && item.dueOn <= addDays(today, NOTICE_DAYS)).length, held, lastRun: last ?? null, nextRun: nextMonday(today) };
  }
  /** What will be deleted and when, held ones included with their hold. */
  async due(page = 1) {
    const today = usDay('latest'), soon = (await this.candidates(today)).filter(item => item.dueOn <= addDays(today, NOTICE_DAYS));
    const settings = await this.settings(), next = nextMonday(today);
    const deletesOn = settings.firstDeletion && settings.firstDeletion > next ? nextMonday(addDays(settings.firstDeletion, -1)) : next;
    return { items: soon.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), total: soon.length, page, pageSize: PAGE_SIZE, deletesOn: settings.deleting ? deletesOn : null };
  }
  /** People whose records some rule will delete one day, by name, to hold before they are due. */
  async people(query: string) {
    const text = query.trim();
    if (text.length < 2) return { items: [] };
    return { items: await this.db.query(`${WITH_HOLDS_SQL} WHERE c.name ILIKE '%' || $2 || '%' ORDER BY c.name LIMIT 20`, [usDay('latest'), text.replace(/[%_\\]/g, '')]) };
  }
  async runs() {
    return { items: await this.db.query(`SELECT day::text AS day, "startedAt", "finishedAt", deleted, held, failed FROM retention_runs ORDER BY day DESC LIMIT 52`) };
  }

  async setDeleting(user: User, deleting: boolean) {
    return this.db.transaction(async em => {
      await em.query(`INSERT INTO retention_settings (id) VALUES (1) ON CONFLICT DO NOTHING`);
      const [current] = await em.query(`SELECT deleting FROM retention_settings WHERE id = 1 FOR UPDATE`);
      if (current.deleting === deleting) throw new BadRequestException(deleting ? 'Deleting is already on.' : 'Deleting is already off.');
      await em.query(`UPDATE retention_settings SET deleting = $1, "updatedBy" = $2, "updatedAt" = now() WHERE id = 1`, [deleting, user.id]);
      await em.query(`INSERT INTO retention_setting_changes (deleting, "changedBy") VALUES ($1, $2)`, [deleting, user.id]);
      return { deleting };
    });
  }
  async hold(user: User, dto: { subjectKind: Subject; subjectId: string; until: string; reason: string }) {
    const today = usDay('latest');
    if (dto.until < today) throw new BadRequestException('Choose today or a later day.');
    if (dto.until > addDays(today, HOLD_MAX_DAYS)) throw new BadRequestException('A hold can be up to 2 years. You can extend it later.');
    const [found] = await this.db.query(`SELECT 1 FROM (${CANDIDATES_SQL}) c WHERE c.subject = $1 AND c.id = $2`, [dto.subjectKind, dto.subjectId]);
    if (!found) throw new NotFoundException('These records aren’t due to be deleted by any rule, so there’s nothing to hold.');
    return this.db.transaction(async em => {
      // A hold that ran out ends now, so a new one can start.
      await em.query(`UPDATE retention_holds SET "endedAt" = now() WHERE "subjectKind" = $1 AND "subjectId" = $2 AND "endedAt" IS NULL AND until < $3::date`, [dto.subjectKind, dto.subjectId, today]);
      const [open] = await em.query(`SELECT id FROM retention_holds WHERE "subjectKind" = $1 AND "subjectId" = $2 AND "endedAt" IS NULL FOR UPDATE`, [dto.subjectKind, dto.subjectId]);
      if (open) throw new ConflictException('These records are already held. Extend that hold instead.');
      const [row] = await em.query(`INSERT INTO retention_holds ("subjectKind", "subjectId", until, reason, "createdBy") VALUES ($1, $2, $3, $4, $5) RETURNING id`, [dto.subjectKind, dto.subjectId, dto.until, dto.reason, user.id]);
      return { id: row.id };
    });
  }
  async extendHold(user: User, id: string, dto: { until: string; reason: string }) {
    const today = usDay('latest');
    if (dto.until > addDays(today, HOLD_MAX_DAYS)) throw new BadRequestException('A hold can be up to 2 years from today.');
    return this.db.transaction(async em => {
      const [hold] = await em.query(`SELECT until::text AS until FROM retention_holds WHERE id = $1 AND "endedAt" IS NULL FOR UPDATE`, [id]);
      if (!hold) throw new NotFoundException('This hold has ended.');
      if (dto.until <= hold.until) throw new BadRequestException('Choose a later day than the hold has now.');
      await em.query(`UPDATE retention_holds SET until = $2, changes = changes || $3::jsonb WHERE id = $1`, [id, dto.until, JSON.stringify([{ from: hold.until, to: dto.until, reason: dto.reason, by: user.id, at: new Date().toISOString() }])]);
      return { id };
    });
  }
  async endHold(user: User, id: string) {
    // An UPDATE answers [rows, count].
    const [rows]: [{ id: string }[], number] = await this.db.query(`UPDATE retention_holds SET "endedAt" = now(), "endedBy" = $2 WHERE id = $1 AND "endedAt" IS NULL RETURNING id`, [id, user.id]);
    if (!rows.length) throw new NotFoundException('This hold has already ended.');
    return { id };
  }

  /** Hourly: on a Monday, while deleting is on, one instance runs the day's deletion once. */
  async tick() {
    const today = usDay('latest');
    if (new Date(`${today}T12:00:00Z`).getUTCDay() !== 1) return null;
    return this.run(today);
  }
  /** Deletes what is due today and not held. Public for tests and the operator. Returns the counts, or null when it didn't run. */
  async run(today: string) {
    const settings = await this.settings();
    if (!settings.deleting || !settings.firstDeletion || settings.firstDeletion > today) return null;
    const runner = this.db.createQueryRunner();
    await runner.connect();
    try {
      const [{ locked }] = await runner.query('SELECT pg_try_advisory_lock($1) AS locked', [RUN_LOCK]);
      if (!locked) return null;
      try {
        const [run] = await runner.query(`INSERT INTO retention_runs (day) VALUES ($1) ON CONFLICT (day) DO NOTHING RETURNING id`, [today]);
        if (!run) return null;
        const unknown = await this.unknownReferences();
        if (unknown.length) {
          // A table added since this job was written: nothing is deleted until the job knows it.
          this.logger.warn(`Retention stopped: ${unknown.length} unknown references`);
          await runner.query(`UPDATE retention_runs SET "finishedAt" = now(), failed = $2 WHERE id = $1`, [run.id, -1]);
          return { deleted: {}, held: 0, failed: -1 };
        }
        const all = await this.candidates(today), due = all.filter(item => item.dueOn <= today && !item.holdId);
        const deleted: Record<string, { records: number; files: number }> = {};
        let failed = 0;
        for (const item of due) {
          try {
            const keys = await this.db.transaction(async em => {
              await em.query(`SET LOCAL operations.retention = 'on'`);
              // Checked again inside: someone may have come back, been held or been reopened since the list was read.
              const [still] = await em.query(`${WITH_HOLDS_SQL} WHERE c.subject = $2 AND c.id = $3`, [today, item.subject, item.id]);
              if (!still || still.holdId || still.dueOn > today) return null;
              return item.subject === 'APPLICATION' ? deleteApplication(em, item.id) : item.subject === 'INVITATION' ? deleteInvitation(em, item.id)
                : item.subject === 'DRIVER' ? deleteDriver(em, item.id) : deleteMember(em, item.id);
            });
            if (!keys) continue;
            for (const key of keys) await this.storage.remove(key);
            const count = deleted[item.kind] ?? { records: 0, files: 0 };
            deleted[item.kind] = { records: count.records + 1, files: count.files + keys.length };
          // The record stays for the next run; the log names the database error code only.
          } catch (error) { failed += 1; this.logger.warn(`Retention: a ${item.subject.toLowerCase()} record failed (${(error as { code?: string }).code ?? "error"})`); }
        }
        const held = all.filter(item => item.dueOn <= today && item.holdId).length;
        await runner.query(`UPDATE retention_runs SET "finishedAt" = now(), deleted = $2, held = $3, failed = $4 WHERE id = $1`, [run.id, JSON.stringify(deleted), held, failed]);
        if (failed) this.logger.warn(`Retention: ${failed} records could not be deleted`);
        return { deleted, held, failed };
      } finally { await runner.query('SELECT pg_advisory_unlock($1)', [RUN_LOCK]); }
    } finally { await runner.release(); }
  }
  /** References to the tables the job deletes from that it doesn't handle. */
  async unknownReferences(): Promise<string[]> {
    const rows: { reference: string }[] = await this.db.query(`SELECT DISTINCT child.relname || '.' || a.attname AS reference
      FROM pg_constraint con JOIN pg_class child ON child.oid = con.conrelid JOIN pg_class parent ON parent.oid = con.confrelid
      JOIN pg_attribute a ON a.attrelid = child.oid AND a.attnum = ANY(con.conkey)
      WHERE con.contype = 'f' AND parent.relname = ANY($1)`, [DELETED_FROM]);
    return rows.map(row => row.reference).filter(reference => !KNOWN_REFERENCES.has(reference));
  }
}
/** The next Monday from a day, that day included. */
function nextMonday(day: string) {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return addDays(day, (8 - weekday) % 7);
}
