import { MigrationInterface, QueryRunner } from 'typeorm';
// Drivers while their dispatcher is away (Design System section 34, "Drivers while their dispatcher is away", approved
// 2026-11-16): putting a dispatcher on leave names who covers each of their drivers. From the first day away each driver's
// assignment moves to the covering dispatcher, and on the return day it moves back, unless the driver was reassigned for good
// meanwhile. If the person on leave is marked as leaving, the drivers stay with whoever covers them. Every move is a
// driver_assignments row, so the driver's history keeps it; this table only remembers the plan and how it ended.
export class LeaveCovers1793280000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`CREATE TABLE driver_leave_covers (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
   "leaveId" uuid NOT NULL REFERENCES member_leaves(id),
   "driverId" uuid NOT NULL REFERENCES drivers(id),
   "coverMemberId" uuid NOT NULL REFERENCES dispatch_members(id),
   "coverAssignmentId" uuid REFERENCES driver_assignments(id),
   "startedAt" timestamptz,
   "endedAt" timestamptz,
   "endedHow" varchar CHECK ("endedHow" IN ('RETURNED','REASSIGNED','KEPT','CANCELLED','SKIPPED')),
   "createdBy" uuid NOT NULL REFERENCES users(id),
   "createdAt" timestamptz NOT NULL DEFAULT now(),
   "updatedAt" timestamptz NOT NULL DEFAULT now(),
   CONSTRAINT "CHK_driver_leave_covers_ended" CHECK (("endedAt" IS NULL) = ("endedHow" IS NULL)),
   CONSTRAINT "CHK_driver_leave_covers_started" CHECK (("startedAt" IS NULL) = ("coverAssignmentId" IS NULL)))`);
  // One open plan per driver in a leave; ended ones stay as history.
  await q.query(`CREATE UNIQUE INDEX "UQ_driver_leave_covers_open" ON driver_leave_covers ("leaveId", "driverId") WHERE "endedAt" IS NULL`);
  await q.query(`CREATE INDEX "IDX_driver_leave_covers_assignment" ON driver_leave_covers ("coverAssignmentId") WHERE "endedAt" IS NULL`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [found] = await q.query(`SELECT EXISTS(SELECT 1 FROM driver_leave_covers) AS found`);
  if (found.found) throw new Error('Refusing to roll back while drivers covered during a leave are recorded.');
  await q.query(`DROP TABLE driver_leave_covers`);
 }
}
