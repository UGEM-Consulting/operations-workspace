import { daysUntil, driverReminderMessage, staffReminderMessage, stepFor, weeklySummaryMessage } from '../src/modules/safety/reminder-messages';
import { DRIVER_STEPS, STAFF_STEPS } from '../src/modules/safety/reminders';

describe('Safety reminder rules and messages', () => {
  it('finds the latest step a date has reached, and none while it is further away', () => {
    const today = '2026-11-09';
    expect(daysUntil('2026-12-09', today)).toBe(30);
    expect(daysUntil('2026-11-01', today)).toBe(-8);
    expect(stepFor('2027-02-01', today, STAFF_STEPS)).toBeNull();
    expect(stepFor('2027-01-08', today, STAFF_STEPS)).toBe(60);
    expect(stepFor('2026-12-09', today, STAFF_STEPS)).toBe(30);
    expect(stepFor('2026-11-20', today, STAFF_STEPS)).toBe(30);
    expect(stepFor('2026-11-16', today, STAFF_STEPS)).toBe(7);
    expect(stepFor('2026-11-09', today, STAFF_STEPS)).toBe(0);
    expect(stepFor('2026-10-01', today, STAFF_STEPS)).toBe(0);
    // Drivers start at 30 days.
    expect(stepFor('2026-12-20', today, DRIVER_STEPS)).toBeNull();
    expect(stepFor('2026-12-01', today, DRIVER_STEPS)).toBe(30);
  });

  it('tells the driver only which document expires and when, with the renewal link', () => {
    const url = 'https://workspace.example.test/driver#token', soon = driverReminderMessage('MEDICAL_CARD', '2026-12-09', '2026-11-09', url);
    expect(soon.email.subject).toBe('Your DOT medical card expires on Dec 9, 2026');
    expect(soon.email.text).toContain(url);
    expect(soon.telegram).not.toContain(url);
    expect(soon.button).toEqual({ text: 'Send the new one', url });
    expect(driverReminderMessage('LICENSE', '2026-11-09', '2026-11-09', url).email.subject).toBe('Your driver’s license expires today');
    expect(driverReminderMessage('LICENSE', '2026-11-01', '2026-11-09', url).email.subject).toBe('Your driver’s license expired on Nov 1, 2026');
  });

  it('names drivers by first name and last initial for staff, and counts only in the weekly summary', () => {
    const daily = staffReminderMessage([{ firstName: 'Morgan', lastName: 'Reyes', kind: 'MEDICAL_CARD', dueOn: '2026-11-09' },
      { firstName: 'Alex', lastName: 'Kim', kind: 'LICENSE', dueOn: '2026-11-30' }, { firstName: 'Drew', lastName: 'Patel', kind: 'ANNUAL_REVIEW', dueOn: '2026-11-01' }], '2026-11-09', 'https://w.example.test/safety/expiring');
    expect(daily.telegram).toContain('Morgan R.: medical card expires today.\nAlex K.: driver’s license expires in 21 days.\nDrew P.: yearly review overdue since Nov 1, 2026.');
    expect(daily.telegram).not.toMatch(/Reyes|Kim|Patel/);
    // Permits of one unit due the same day share one line that names each of them.
    const permits = staffReminderMessage([{ firstName: null, lastName: null, unit: '233', kind: 'PERMIT', dueOn: '2026-11-16', permits: ['IFTA', 'NM'] },
      { firstName: null, lastName: null, unit: '240', kind: 'PERMIT', dueOn: '2026-11-16', permits: ['OR'] }], '2026-11-09', 'https://w.example.test/safety/expiring');
    expect(permits.telegram).toContain('Unit 233: IFTA and New Mexico permits expire in 7 days.\nUnit 240: Oregon permit expires in 7 days.');
    const weekly = weeklySummaryMessage({ expired: 1, onHold: 1, expiringSoon: 3, waiting: 2, reviewsDue: 0 }, 'https://w.example.test/safety/expiring');
    expect(weekly.telegram).toContain('Expired: 1 document, 1 driver on hold.\nExpiring within 30 days: 3.\nWaiting for a check: 2 renewal scans.\nYearly reviews due: 0.');
  });
});
