/** A person's name from a users, drivers or dispatch_members row aliased `alias` (null when the join found none), as SQL. */
export const personName = (alias: string) => `CASE WHEN ${alias}.id IS NULL THEN NULL ELSE ${alias}."firstName" || ' ' || ${alias}."lastName" END`;
