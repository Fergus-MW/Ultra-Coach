import type { PlanWeek, PlannedSession, SessionType, TrainingPlan, ZoneNumber } from '../types';

export interface PlanConfig {
  raceName: string;
  raceDateIso: string;
  raceDistanceKm: number;
  startDateIso: string;
  /** Minutes of running in a typical current week. */
  currentWeeklyMin: number;
  /** Longest run in the last month, in minutes. */
  currentLongRunMin: number;
  daysPerWeek: 3 | 4 | 5 | 6;
}

const MS_PER_DAY = 86_400_000;
const WEEKLY_GROWTH = 1.08;
const DOWN_WEEK_FACTOR = 0.7;
const TAPER_FACTORS = [0.65, 0.45, 0.3];
const MAX_WEEKLY_MIN = 900;

export const DEFAULT_PLAN_CONFIG: PlanConfig = {
  raceName: 'Ultra',
  raceDateIso: isoDateAfter(new Date().toISOString().slice(0, 10), 16 * 7),
  raceDistanceKm: 50,
  startDateIso: new Date().toISOString().slice(0, 10),
  currentWeeklyMin: 240,
  currentLongRunMin: 90,
  daysPerWeek: 5,
};

export function isoDateAfter(startIso: string, days: number): string {
  const date = new Date(`${startIso}T00:00:00Z`);
  return new Date(date.getTime() + days * MS_PER_DAY).toISOString().slice(0, 10);
}

export function weeksBetween(startIso: string, endIso: string): number {
  const start = new Date(`${startIso}T00:00:00Z`).getTime();
  const end = new Date(`${endIso}T00:00:00Z`).getTime();
  return Math.max(1, Math.floor((end - start) / (7 * MS_PER_DAY)));
}

/** Which weekday slots carry which kind of session, by weekly frequency. */
const WEEK_TEMPLATES: Record<number, (SessionType | null)[]> = {
  3: [null, 'easy', null, 'quality' as SessionType, null, 'long', null],
  4: [null, 'easy', 'quality' as SessionType, null, 'easy', 'long', null],
  5: [null, 'easy', 'quality' as SessionType, 'easy', null, 'long', 'recovery'],
  6: [null, 'easy', 'quality' as SessionType, 'easy', 'recovery', 'long', 'recovery'],
};

const QUALITY_BY_PHASE: Record<PlanWeek['phase'], SessionType> = {
  base: 'hills',
  build: 'tempo',
  peak: 'intervals',
  taper: 'tempo',
  race: 'easy',
};

const TARGET_ZONE: Record<SessionType, ZoneNumber> = {
  recovery: 1,
  easy: 2,
  long: 2,
  hills: 3,
  tempo: 3,
  intervals: 4,
  rest: 1,
};

function phaseFor(weekIndex: number, totalWeeks: number): PlanWeek['phase'] {
  const fromEnd = totalWeeks - weekIndex;
  if (fromEnd <= 1) return 'race';
  if (fromEnd <= TAPER_FACTORS.length + 1) return 'taper';
  if (weekIndex < Math.ceil(totalWeeks * 0.3)) return 'base';
  if (weekIndex < Math.ceil(totalWeeks * 0.7)) return 'build';
  return 'peak';
}

function segmentsFor(type: SessionType, durationMin: number): PlannedSession['segments'] {
  const warmup = Math.min(15, Math.round(durationMin * 0.2));
  const cooldown = warmup;
  const work = Math.max(5, durationMin - warmup - cooldown);
  if (type === 'tempo') {
    return [
      { label: 'Warm up easy', durationMin: warmup, targetZone: 2 },
      { label: 'Tempo block', durationMin: work, targetZone: 3 },
      { label: 'Cool down', durationMin: cooldown, targetZone: 1 },
    ];
  }
  if (type === 'intervals') {
    return [
      { label: 'Warm up easy', durationMin: warmup, targetZone: 2 },
      { label: 'Hard reps', durationMin: work, targetZone: 4 },
      { label: 'Cool down', durationMin: cooldown, targetZone: 1 },
    ];
  }
  if (type === 'hills') {
    return [
      { label: 'Warm up easy', durationMin: warmup, targetZone: 2 },
      { label: 'Hill repeats, hike the steep bits', durationMin: work, targetZone: 3 },
      { label: 'Cool down', durationMin: cooldown, targetZone: 1 },
    ];
  }
  return undefined;
}

function titleFor(type: SessionType, durationMin: number, distanceKm: number): string {
  switch (type) {
    case 'long':
      return `Long run · ${Math.round(durationMin / 5) * 5} min`;
    case 'tempo':
      return 'Tempo';
    case 'intervals':
      return 'Intervals';
    case 'hills':
      return 'Hills';
    case 'recovery':
      return 'Recovery jog';
    case 'rest':
      return 'Rest';
    default:
      return distanceKm >= 80 ? 'Easy miles' : 'Easy run';
  }
}

function notesFor(type: SessionType): string {
  switch (type) {
    case 'long':
      return 'Race kit, race fuel. Practise eating every 30 minutes even when you do not want to.';
    case 'tempo':
      return 'Comfortably hard. You should be able to speak a short sentence, not a paragraph.';
    case 'intervals':
      return 'Hard efforts with full recoveries. Stop the session if form falls apart.';
    case 'hills':
      return 'Run the runnable, hike the steep. Hiking is a trained skill, not a failure.';
    case 'recovery':
      return 'Slower than feels right. This one only works if it is genuinely easy.';
    default:
      return 'Conversational the whole way.';
  }
}

/**
 * Builds a progressive ultra block: three weeks up, one week down, three weeks
 * of taper, with the long run carrying the largest share of weekly volume.
 */
export function generatePlan(config: PlanConfig): TrainingPlan {
  const totalWeeks = weeksBetween(config.startDateIso, config.raceDateIso);
  const template = WEEK_TEMPLATES[config.daysPerWeek];
  const weeks: PlanWeek[] = [];
  let volume = config.currentWeeklyMin;
  let longRun = config.currentLongRunMin;

  for (let weekIndex = 0; weekIndex < totalWeeks; weekIndex += 1) {
    const phase = phaseFor(weekIndex, totalWeeks);
    const isDownWeek = phase !== 'taper' && phase !== 'race' && weekIndex > 0 && weekIndex % 4 === 3;

    if (weekIndex > 0) {
      if (phase === 'taper' || phase === 'race') {
        const taperIndex = Math.max(0, totalWeeks - 1 - weekIndex);
        const factor = TAPER_FACTORS[Math.min(taperIndex, TAPER_FACTORS.length - 1)];
        volume = Math.round(config.currentWeeklyMin * Math.max(1, WEEKLY_GROWTH) * factor * 1.6);
        longRun = Math.round(longRun * 0.7);
      } else if (!isDownWeek) {
        volume = Math.min(MAX_WEEKLY_MIN, Math.round(volume * WEEKLY_GROWTH));
        longRun = Math.min(Math.round(volume * 0.4), Math.round(longRun * WEEKLY_GROWTH));
      }
    }

    const weekVolume = Math.round(isDownWeek ? volume * DOWN_WEEK_FACTOR : volume);
    const weekLongRun = Math.round(isDownWeek ? longRun * DOWN_WEEK_FACTOR : longRun);
    const sessions: PlannedSession[] = [];
    const qualityType = QUALITY_BY_PHASE[phase];
    const easySlots = template.filter((slot) => slot === 'easy' || slot === 'recovery').length;
    const qualityMin = phase === 'race' ? 0 : Math.round(weekVolume * 0.15);
    const easyBudget = Math.max(0, weekVolume - weekLongRun - qualityMin);

    template.forEach((slot, dayOfWeek) => {
      if (!slot) return;
      const dayIndex = weekIndex * 7 + dayOfWeek;
      const isRaceDay = phase === 'race' && slot === 'long';
      const type: SessionType = isRaceDay ? 'long' : slot === ('quality' as SessionType) ? qualityType : slot;
      let durationMin: number;
      if (isRaceDay) durationMin = Math.round(config.raceDistanceKm * 7.5);
      else if (slot === 'long') durationMin = weekLongRun;
      else if (slot === ('quality' as SessionType)) durationMin = qualityMin;
      else durationMin = Math.round(easyBudget / Math.max(1, easySlots));
      if (durationMin < 15) return;

      sessions.push({
        id: `w${weekIndex + 1}d${dayOfWeek}`,
        dayIndex,
        weekIndex,
        type,
        title: isRaceDay ? `${config.raceName} · race day` : titleFor(type, durationMin, config.raceDistanceKm),
        durationMin,
        targetZone: TARGET_ZONE[type],
        notes: isRaceDay ? 'Start slower than feels right. Eat from the first hour.' : notesFor(type),
        segments: isRaceDay ? undefined : segmentsFor(type, durationMin),
      });
    });

    weeks.push({
      index: weekIndex,
      volumeMin: sessions.reduce((sum, session) => sum + session.durationMin, 0),
      phase,
      isDownWeek,
      sessions,
    });
  }

  return {
    createdAt: Date.now(),
    raceName: config.raceName,
    raceDateIso: config.raceDateIso,
    raceDistanceKm: config.raceDistanceKm,
    weeks,
  };
}

export function sessionForDate(plan: TrainingPlan, startDateIso: string, dateIso: string): PlannedSession | null {
  const start = new Date(`${startDateIso}T00:00:00Z`).getTime();
  const target = new Date(`${dateIso}T00:00:00Z`).getTime();
  const dayIndex = Math.floor((target - start) / MS_PER_DAY);
  for (const week of plan.weeks) {
    const match = week.sessions.find((session) => session.dayIndex === dayIndex);
    if (match) return match;
  }
  return null;
}

export function upcomingSessions(
  plan: TrainingPlan,
  startDateIso: string,
  dateIso: string,
  count: number,
): PlannedSession[] {
  const start = new Date(`${startDateIso}T00:00:00Z`).getTime();
  const target = new Date(`${dateIso}T00:00:00Z`).getTime();
  const dayIndex = Math.floor((target - start) / MS_PER_DAY);
  return plan.weeks
    .flatMap((week) => week.sessions)
    .filter((session) => session.dayIndex >= dayIndex)
    .slice(0, count);
}

export function sessionDateIso(startDateIso: string, session: PlannedSession): string {
  return isoDateAfter(startDateIso, session.dayIndex);
}
