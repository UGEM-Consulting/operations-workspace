import { ConflictException } from '@nestjs/common';
import { ApplicationStatus } from './entities';
// Saving a draft does not transition its status. Future IT states require a new policy/migration.
// A manager may reject while corrections are outstanding (the applicant never resubmitted); APPROVED/REJECTED stay terminal.
const transitions: Record<ApplicationStatus, readonly ApplicationStatus[]> = {
 INVITED: ['DRAFT'],
 DRAFT: ['SUBMITTED'],
 SUBMITTED: ['CHANGES_REQUESTED', 'APPROVED', 'REJECTED'],
 CHANGES_REQUESTED: ['RESUBMITTED', 'REJECTED'],
 RESUBMITTED: ['CHANGES_REQUESTED', 'APPROVED', 'REJECTED'],
 APPROVED: [],
 REJECTED: [],
};
export function requireTransition(from: ApplicationStatus, to: ApplicationStatus): void {
 if (!transitions[from]?.includes(to)) throw new ConflictException('This application transition is not allowed.');
}
