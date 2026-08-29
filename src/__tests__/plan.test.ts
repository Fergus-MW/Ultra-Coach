import { DEFAULT_PLAN_CONFIG, generatePlan, isoDateAfter, sessionForDate, upcomingSessions } from '../coach/plan';

const CONFIG = {
  ...DEFAULT_PLAN_CONFIG,
  raceName: 'Test 50',
  startDateIso: '2026-01-05',
  raceDateIso: isoDateAfter('2026-01-05', 12 * 7),
  currentWeeklyMin: 240,
  currentLongRunMin: 90,
};

describe('generatePlan', () => {
  const plan = generatePlan(CONFIG);

  it('covers the weeks up to race day', () => {
    expect(plan.weeks).toHaveLength(12);
    expect(plan.weeks[plan.weeks.length - 1].phase).toBe('race');
  });

  it('progresses volume then tapers into race week', () => {
    const training = plan.weeks.filter((week) => week.phase !== 'race');
    const peak = Math.max(...training.map((week) => week.volumeMin));
    expect(peak).toBeGreaterThan(CONFIG.currentWeeklyMin);
    // Race week volume is dominated by the race itself, so the taper is judged
    // on the last week of actual training.
    expect(training[training.length - 1].volumeMin).toBeLessThan(peak * 0.75);
  });

  it('inserts recovery weeks', () => {
    expect(plan.weeks.some((week) => week.isDownWeek)).toBe(true);
  });

  it('gives every week a long run', () => {
    for (const week of plan.weeks.slice(0, -1)) {
      expect(week.sessions.some((session) => session.type === 'long')).toBe(true);
    }
  });

  it('finds the session for a date and the ones after it', () => {
    const first = plan.weeks[0].sessions[0];
    const dateIso = isoDateAfter(CONFIG.startDateIso, first.dayIndex);
    expect(sessionForDate(plan, CONFIG.startDateIso, dateIso)?.id).toBe(first.id);
    expect(upcomingSessions(plan, CONFIG.startDateIso, dateIso, 3)).toHaveLength(3);
  });
});
