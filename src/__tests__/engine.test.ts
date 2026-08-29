import { CoachEngine, DEFAULT_COACH_CONFIG, type CoachInput, type SessionTarget } from '../coach/engine';
import { DEFAULT_ZONES } from '../metrics';
import type { RunMetrics } from '../types';

const START = 1_700_000_000_000;

const TARGET: SessionTarget = { zone: 2, durationMin: 60, type: 'easy', label: 'Easy hour' };

function metrics(patch: Partial<RunMetrics> = {}): RunMetrics {
  return {
    elapsedMs: 60_000,
    movingMs: 60_000,
    distanceM: 200,
    elevationGainM: 0,
    elevationLossM: 0,
    paceSecPerKm: 330,
    averagePaceSecPerKm: 330,
    gradientPct: 0,
    heartRateBpm: 140,
    heartRateAvgBpm: 140,
    zone: 2,
    heartRateAgeMs: 1000,
    ...patch,
  };
}

function input(now: number, patch: Partial<RunMetrics> = {}, target: SessionTarget = TARGET): CoachInput {
  return { now, metrics: metrics({ elapsedMs: now - START, ...patch }), target, zones: DEFAULT_ZONES };
}

/** Feeds one second ticks and collects every cue the engine emits. */
function run(engine: CoachEngine, fromSec: number, toSec: number, patch: Partial<RunMetrics>) {
  const ids: string[] = [];
  for (let second = fromSec; second <= toSec; second += 1) {
    const cue = engine.update(input(START + second * 1000, patch));
    if (cue) ids.push(cue.id);
  }
  return ids;
}

describe('CoachEngine', () => {
  it('opens with a start cue', () => {
    expect(new CoachEngine(START).start().id).toBe('run_start');
  });

  it('warns only after the heart rate stays high for the sustain window', () => {
    const engine = new CoachEngine(START);
    const early = run(engine, 1, 15, { heartRateBpm: 175, zone: 5 });
    expect(early).toEqual([]);
    const later = run(engine, 16, 30, { heartRateBpm: 175, zone: 5 });
    expect(later).toContain('zone_high');
  });

  it('keeps a reminder pending when a warning outranks it', () => {
    // The fuel reminder comes due in the same second as a zone warning, which
    // outranks it. The fuel line must come back on a later tick rather than
    // being consumed and pushed out to the next full interval.
    const engine = new CoachEngine(START, { ...DEFAULT_COACH_CONFIG, fuelIntervalMs: 21_000 });
    const contested = run(engine, 1, 21, { heartRateBpm: 175, zone: 5 });
    expect(contested).toEqual(['zone_high']);
    const after = run(engine, 22, 41, { heartRateBpm: 140, zone: 2 });
    expect(after).toContain('fuel');
  });

  it('restarts the sustain window after a heart rate dropout', () => {
    const engine = new CoachEngine(START);
    run(engine, 1, 18, { heartRateBpm: 175, zone: 5 });
    run(engine, 19, 25, { heartRateBpm: null, zone: null, heartRateAgeMs: 40_000 });
    // The strap comes back reading high: the twenty second window starts again
    // rather than firing on time accrued while there was no signal.
    expect(run(engine, 26, 40, { heartRateBpm: 175, zone: 5 })).not.toContain('zone_high');
    expect(run(engine, 41, 50, { heartRateBpm: 175, zone: 5 })).toContain('zone_high');
  });

  it('confirms the return to zone once', () => {
    const engine = new CoachEngine(START);
    run(engine, 1, 40, { heartRateBpm: 175, zone: 5 });
    const back = run(engine, 41, 60, { heartRateBpm: 140, zone: 2 });
    expect(back.filter((id) => id === 'zone_back')).toHaveLength(1);
  });

  it('does not nag about a low heart rate on a climb', () => {
    const engine = new CoachEngine(START);
    const climbing = run(engine, 1, 200, { heartRateBpm: 95, zone: 1, gradientPct: 12 });
    expect(climbing).not.toContain('zone_low');
  });

  it('tells you to hike a sustained steep climb', () => {
    const engine = new CoachEngine(START);
    const cues = run(engine, 1, 60, { gradientPct: 14 });
    expect(cues).toContain('hill_hike');
  });

  it('reminds you to eat and drink on schedule', () => {
    const engine = new CoachEngine(START);
    const cues = run(engine, 1, 40 * 60, { distanceM: 100 });
    expect(cues).toContain('drink');
    expect(cues).toContain('fuel');
  });

  it('honours the minimum gap between low priority cues', () => {
    const engine = new CoachEngine(START, { ...DEFAULT_COACH_CONFIG, minGapMs: 600_000 });
    const cues = run(engine, 1, 30 * 60, {});
    for (let index = 1; index < cues.length; index += 1) {
      expect(cues[index]).toBeDefined();
    }
    expect(cues.length).toBeLessThan(6);
  });

  it('announces splits by distance', () => {
    const engine = new CoachEngine(START);
    const cues = [
      engine.update(input(START + 60_000, { distanceM: 500 })),
      engine.update(input(START + 300_000, { distanceM: 1010 })),
    ].filter((cue) => cue !== null);
    expect(cues.map((cue) => cue.id)).toContain('split');
  });

  it('flags a lost strap and its return', () => {
    const engine = new CoachEngine(START);
    const lost = run(engine, 40, 60, { heartRateBpm: null, zone: null, heartRateAgeMs: 40_000 });
    expect(lost).toContain('hr_lost');
    const back = run(engine, 61, 80, {});
    expect(back).toContain('hr_restored');
  });

  it('closes with a spoken summary', () => {
    const engine = new CoachEngine(START);
    const cues = engine.finish(metrics({ distanceM: 21_100, elapsedMs: 7_200_000 }));
    expect(cues).toHaveLength(2);
    expect(cues[1].text).toContain('21 kilometres');
    expect(cues[1].text).toContain('2 hours');
  });
});
