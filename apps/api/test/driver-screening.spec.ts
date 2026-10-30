import { ADVERSE_WAIT_BUSINESS_DAYS, earliestFinalRejection } from '../src/modules/safety/safety.entity';
import { addDays, usDay } from '../src/modules/safety/screening-rules';

describe('the waiting period after a pre-adverse notice', () => {
  it('counts business days, skipping weekends', () => {
    expect(ADVERSE_WAIT_BUSINESS_DAYS).toBe(5);
    expect(earliestFinalRejection('2026-10-30')).toBe('2026-11-06'); // Friday → the next Friday
    expect(earliestFinalRejection('2026-11-04')).toBe('2026-11-11'); // Wednesday → the next Wednesday
    expect(earliestFinalRejection('2026-10-31')).toBe('2026-11-06'); // a Saturday notice starts counting on Monday
    expect(earliestFinalRejection('2026-12-28')).toBe('2027-01-04'); // across the year end
  });
});

describe('dates as the mainland US sees them', () => {
  it('uses the Eastern date for “not in the future” and the Pacific date for “the wait is over”', () => {
    // 03:30 UTC on Nov 9 is still Nov 8 in New York and in Los Angeles.
    const lateEvening = Date.parse('2026-11-09T03:30:00Z');
    expect([usDay('latest', lateEvening), usDay('earliest', lateEvening)]).toEqual(['2026-11-08', '2026-11-08']);
    // 06:00 UTC: New York has reached Nov 9, Los Angeles hasn't, so a wait ending Nov 9 isn't over yet.
    const overnight = Date.parse('2026-11-09T06:00:00Z');
    expect([usDay('latest', overnight), usDay('earliest', overnight)]).toEqual(['2026-11-09', '2026-11-08']);
    expect(addDays('2026-11-01', -30)).toBe('2026-10-02');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});
