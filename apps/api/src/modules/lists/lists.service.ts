import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import type { User } from '../users/user.entity';
import { CreateMcDto, UpdateMcDto } from './lists.dto';
import { JobTitle, ListEvent, ListEventType, ListKind, listNameKey, Mc } from './lists.entity';

type Item = Mc | JobTitle;
const TABLES: Record<ListKind, { entity: typeof Mc | typeof JobTitle; table: string; column: string; label: string }> = {
 MC: { entity: Mc, table: 'mcs', column: 'mcName', label: 'An MC' },
 JOB_TITLE: { entity: JobTitle, table: 'job_titles', column: 'jobTitle', label: 'A job title' },
};
// Unique indexes from ManagedLists1792810000000, turned into messages a person can act on.
const DUPLICATES: Record<string, string> = {
 UQ_mcs_nameKey: 'An MC with this name already exists.', UQ_job_titles_nameKey: 'A job title with this name already exists.',
 UQ_mcs_mcNumber: 'Another MC already has this MC number.', UQ_mcs_dotNumber: 'Another MC already has this DOT number.',
};

/**
 * MCs and job titles: the shared choices forms pick from. Dispatcher managers and administrators manage them; items
 * are archived rather than deleted so records that use them keep working. Every change writes a metadata-only event.
 */
@Injectable()
export class ListsService {
 constructor(private readonly db: DataSource) {}

 async list(kind: ListKind, status: 'ACTIVE' | 'ARCHIVED' | 'ALL' = 'ALL') {
  const { table, column } = TABLES[kind];
  // "Used by" counts approved dispatchers whose confirmed assignment matches the entry's name.
  const rows: Record<string, unknown>[] = await this.db.query(`SELECT l.*, (SELECT count(*)::integer FROM invitations i JOIN dispatcher_applications a ON a."invitationId" = i.id
    WHERE a.status = 'APPROVED' AND lower(regexp_replace(btrim(i."${column}"), '\\s+', ' ', 'g')) = l."nameKey") AS usage
   FROM ${table} l WHERE ($1 = 'ALL' OR ($1 = 'ACTIVE') = (l."archivedAt" IS NULL)) ORDER BY l."nameKey"`, [status]);
  const [counts] = await this.db.query(`SELECT count(*) FILTER (WHERE "archivedAt" IS NULL)::integer AS active, count(*) FILTER (WHERE "archivedAt" IS NOT NULL)::integer AS archived FROM ${table}`);
  return { items: rows.map(row => this.view(kind, row as unknown as Item & { usage: number })), counts };
 }

 async create(user: User, kind: ListKind, dto: CreateMcDto) {
  this.checkName(kind, dto.name);
  return this.write(async manager => {
   const repo = manager.getRepository<Item>(TABLES[kind].entity);
   const item = await repo.save(repo.create({ name: dto.name, nameKey: listNameKey(dto.name),
    ...(kind === 'MC' ? { mcNumber: dto.mcNumber || null, dotNumber: dto.dotNumber || null } : {}) }));
   await this.event(manager, kind, item.id, user, 'CREATED', { fields: ['name', ...(kind === 'MC' ? ['mcNumber', 'dotNumber'].filter(field => dto[field as 'mcNumber']) : [])] });
   return this.view(kind, { ...item, usage: 0 });
  });
 }

 async update(user: User, kind: ListKind, id: string, dto: UpdateMcDto) {
  if (dto.name !== undefined) this.checkName(kind, dto.name);
  return this.write(async manager => {
   const repo = manager.getRepository<Item>(TABLES[kind].entity);
   const item = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
   if (!item) throw new NotFoundException('This entry no longer exists.');
   if (item.version !== dto.version) throw new ConflictException('Someone else changed this entry. Reload the list and try again.');
   const fields: string[] = [];
   if (dto.name !== undefined && dto.name !== item.name) { item.name = dto.name; item.nameKey = listNameKey(dto.name); fields.push('name'); }
   if (item instanceof Mc) for (const field of ['mcNumber', 'dotNumber'] as const) {
    const value = dto[field] === undefined ? undefined : dto[field] || null;
    if (value !== undefined && value !== item[field]) { item[field] = value; fields.push(field); }
   }
   const archive = dto.archived === undefined || dto.archived === (item.archivedAt !== null) ? null : dto.archived;
   if (archive !== null) item.archivedAt = archive ? new Date() : null;
   if (!fields.length && archive === null) return this.view(kind, { ...item, usage: 0 });
   item.version += 1;
   const saved = await repo.save(item);
   if (fields.length) await this.event(manager, kind, id, user, 'UPDATED', { fields });
   if (archive !== null) await this.event(manager, kind, id, user, archive ? 'ARCHIVED' : 'RESTORED', {});
   return this.view(kind, { ...saved, usage: 0 });
  });
 }

 // "Independent" is a fixed choice in forms, never an MC entry.
 private checkName(kind: ListKind, name: string) {
  if (kind === 'MC' && listNameKey(name) === 'independent') throw new BadRequestException('Independent is already a fixed choice; it isn’t added as an MC.');
 }
 private async write<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
  try { return await this.db.transaction(work); }
  catch (error) {
   const driver = error instanceof QueryFailedError ? error.driverError as { code?: string; constraint?: string } : null;
   if (driver?.code === '23505') throw new ConflictException(DUPLICATES[driver.constraint ?? ''] ?? 'This entry already exists.');
   throw error;
  }
 }
 private event(manager: EntityManager, list: ListKind, itemId: string, user: User, event: ListEventType, metadata: Record<string, unknown>) {
  return manager.getRepository(ListEvent).save({ list, itemId, actorId: user.id, event, metadata });
 }
 private view(kind: ListKind, item: Item & { usage: number }) {
  return { id: item.id, name: item.name, ...(kind === 'MC' ? { mcNumber: (item as Mc).mcNumber, dotNumber: (item as Mc).dotNumber } : {}),
   archived: item.archivedAt !== null, version: item.version, usage: Number(item.usage), updatedAt: item.updatedAt };
 }
}
