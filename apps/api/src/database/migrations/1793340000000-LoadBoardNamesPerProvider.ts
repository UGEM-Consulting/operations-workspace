import { MigrationInterface, QueryRunner } from 'typeorm';
// Load board account names are unique per provider, not across both (the user's request, 2026-11-18): the company often has
// a DAT and a Truckstop account under the same name, such as "Lakeside Carriers". The name is still unique ignoring case and
// spacing within DAT and within Truckstop. The rollback refuses while a name is used by both providers.
export class LoadBoardNamesPerProvider1793340000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`DROP INDEX "UQ_load_board_accounts_nameKey"`);
  await q.query(`CREATE UNIQUE INDEX "UQ_load_board_accounts_provider_nameKey" ON load_board_accounts (provider, "nameKey")`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [found] = await q.query(`SELECT EXISTS(SELECT 1 FROM load_board_accounts GROUP BY "nameKey" HAVING count(*) > 1) AS found`);
  if (found.found) throw new Error('Refusing to roll back while a load board account name is used by both DAT and Truckstop.');
  await q.query(`DROP INDEX "UQ_load_board_accounts_provider_nameKey"`);
  await q.query(`CREATE UNIQUE INDEX "UQ_load_board_accounts_nameKey" ON load_board_accounts ("nameKey")`);
 }
}
