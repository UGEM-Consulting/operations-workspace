import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { listNameKey } from '../lists/lists.entity';
import type { ApplicationFields } from './entities';

/** A team choice, never an MC: they dispatch for the MC directly, with no team (section 31, approved 2026-11-09). */
export const INDEPENDENT = 'Independent';
/** Saved when the applicant's choice isn't on a list; the manager picks the real entry at approval. */
export const NOT_LISTED = 'Not listed';

/** Applicants see MC names only, never MC or DOT numbers. A team's value is the text approval matches: its lead's name, or its own name while it has no lead. */
export async function applicantEmploymentOptions(em: EntityManager) {
 const mcs: { name: string }[] = await em.query(`SELECT name FROM mcs WHERE "archivedAt" IS NULL ORDER BY "nameKey"`);
 const teams: { name: string; mc: string; value: string; led: boolean }[] = await em.query(`SELECT t.name, m.name AS mc, CASE WHEN l.id IS NULL THEN t.name ELSE l."firstName" || ' ' || l."lastName" END AS value, l.id IS NOT NULL AS led
  FROM teams t JOIN mcs m ON m.id = t."mcId" LEFT JOIN dispatch_members l ON l.id = t."leadMemberId"
  WHERE t."archivedAt" IS NULL AND m."archivedAt" IS NULL ORDER BY t."nameKey"`);
 const jobTitles: { name: string }[] = await em.query(`SELECT name FROM job_titles WHERE "archivedAt" IS NULL ORDER BY "nameKey"`);
 return { mcs: mcs.map(item => item.name), teams, jobTitles: jobTitles.map(item => item.name) };
}
type Options = Awaited<ReturnType<typeof applicantEmploymentOptions>>;

const same = (a?: string, b?: string) => listNameKey(a ?? '') === listNameKey(b ?? '');
function choose(value: string, allowed: string[], name: string) {
 const match = allowed.find(item => same(item, value));
 if (!match) throw new BadRequestException(`That ${name} isn't on the list. Choose it again.`);
 return match;
}
/** The teams an applicant may pick once they have chosen this MC: Independent (no team), one of its teams, or not listed. */
function teamChoices(options: Options, mc: string) {
 if (same(mc, NOT_LISTED)) return [NOT_LISTED];
 return [INDEPENDENT, ...options.teams.filter(team => same(team.mc, mc)).map(team => team.value), NOT_LISTED];
}
/**
 * Applicants pick employment from the lists. An answer that didn't change stays as it is, so a manager's pre-filled
 * choice and answers typed before the lists keep working until the applicant changes them. Saves the list's spelling.
 */
export async function settleApplicantEmployment(em: EntityManager, before: ApplicationFields, after: ApplicationFields) {
 const mcMoved = !same(before.mcName, after.mcName), teamMoved = mcMoved || !same(before.teamLead, after.teamLead), titleMoved = !same(before.jobTitle, after.jobTitle);
 if (!mcMoved && !teamMoved && !titleMoved) return;
 const options = await applicantEmploymentOptions(em);
 if (mcMoved && after.mcName?.trim()) after.mcName = choose(after.mcName, [...options.mcs, NOT_LISTED], 'MC');
 if (teamMoved && after.teamLead?.trim()) after.teamLead = choose(after.teamLead, teamChoices(options, after.mcName ?? ''), 'team');
 if (titleMoved && after.jobTitle?.trim()) after.jobTitle = choose(after.jobTitle, [...options.jobTitles, NOT_LISTED], 'job title');
}
