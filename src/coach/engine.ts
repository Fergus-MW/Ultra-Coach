import { zoneRangeBpm } from '../metrics';
import type { HeartRateZones, RunMetrics, SessionType, ZoneNumber } from '../types';
import type { Cue, CueId } from './cues';
import { distanceLabel, durationLabel, paceLabel, staticCueText } from './cues';

export interface CoachConfig {
  /** Minimum silence between any two cues, so the coach is not a nag. */
  minGapMs: number;
  zoneHighSustainMs: number;
  zoneLowSustainMs: number;
  hillGradientPct: number;
  descentGradientPct: number;
  gradientSustainMs: number;
  fuelIntervalMs: number;
  drinkIntervalMs: number;
  splitEveryM: number;
  /** Percentage rise in heart rate at equal pace that counts as drift. */
  driftThresholdPct: number;
  useMiles: boolean;
  splitsEnabled: boolean;
  fuellingEnabled: boolean;
}

export const DEFAULT_COACH_CONFIG: CoachConfig = {
  minGapMs: 15_000,
  zoneHighSustainMs: 20_000,
  zoneLowSustainMs: 90_000,
  hillGradientPct: 8,
  descentGradientPct: -8,
  gradientSustainMs: 15_000,
  fuelIntervalMs: 30 * 60_000,
  drinkIntervalMs: 20 * 60_000,
  splitEveryM: 1000,
  driftThresholdPct: 5,
  useMiles: false,
  splitsEnabled: true,
  fuellingEnabled: true,
};

export interface SessionTarget {
  zone: ZoneNumber;
  durationMin: number;
  type: SessionType;
  label: string;
}

export interface CoachInput {
  now: number;
  metrics: RunMetrics;
  target: SessionTarget;
  zones: HeartRateZones;
  /** Set once when the run transitions to a new plan segment. */
  segmentLabel?: string;
}

export interface DriftSample {
  atMs: number;
  bpm: number;
  paceSecPerKm: number;
}

const PRIORITY: Record<CueId, number> = {
  hr_lost: 40,
  zone_high: 90,
  zone_low: 50,
  zone_back: 45,
  hill_hike: 70,
  descent: 55,
  cardiac_drift: 65,
  fuel: 60,
  drink: 58,
  split: 30,
  halfway: 35,
  segment_change: 85,
  target_reached: 80,
  hr_restored: 35,
  run_start: 100,
  run_end: 100,
};

const NON_INTERRUPTIBLE: CueId[] = ['zone_high', 'hill_hike', 'segment_change', 'run_start', 'run_end'];

interface EngineState {
  rotation: Record<string, number>;
  lastCueAt: number;
  lastFiredAt: Partial<Record<CueId, number>>;
  zoneHighSince: number | null;
  zoneLowSince: number | null;
  hillSince: number | null;
  descentSince: number | null;
  outOfZone: boolean;
  lastSplitM: number;
  lastFuelAt: number | null;
  lastDrinkAt: number | null;
  driftBaseline: DriftSample | null;
  hrLost: boolean;
  halfwayDone: boolean;
  targetDone: boolean;
  lastSegmentLabel: string | null;
}

/** A cue that has met its condition, plus the state change to apply if it wins. */
interface Candidate {
  cue: Cue;
  commit: () => void;
}

const HR_LOST_AFTER_MS = 30_000;
const DRIFT_MIN_INTERVAL_MS = 15 * 60_000;
const DRIFT_PACE_TOLERANCE = 0.06;

/**
 * The on-device rules engine. It is deliberately synchronous, pure of I/O and
 * driven by an explicit `now`, so the whole coaching behaviour is unit testable
 * and a threshold crossing costs no network round trip.
 */
export class CoachEngine {
  private config: CoachConfig;
  private state: EngineState;

  constructor(startedAt: number, config: CoachConfig = DEFAULT_COACH_CONFIG) {
    this.config = config;
    this.state = {
      rotation: {},
      lastCueAt: startedAt - config.minGapMs,
      lastFiredAt: {},
      zoneHighSince: null,
      zoneLowSince: null,
      hillSince: null,
      descentSince: null,
      outOfZone: false,
      lastSplitM: 0,
      lastFuelAt: startedAt,
      lastDrinkAt: startedAt,
      driftBaseline: null,
      hrLost: false,
      halfwayDone: false,
      targetDone: false,
      lastSegmentLabel: null,
    };
  }

  setConfig(config: CoachConfig): void {
    this.config = config;
  }

  private next(id: CueId, text: string, dynamic: boolean): Cue {
    return {
      id,
      text,
      priority: PRIORITY[id],
      interruptible: !NON_INTERRUPTIBLE.includes(id),
      dynamic,
    };
  }

  private staticCue(id: CueId): Cue {
    const rotation = this.state.rotation[id] ?? 0;
    this.state.rotation[id] = rotation + 1;
    return this.next(id, staticCueText(id, rotation), false);
  }

  private candidate(cue: Cue, commit: () => void = () => undefined): Candidate {
    return { cue, commit };
  }

  /** Phrase rotation only advances if the line is actually spoken. */
  private staticCandidate(id: CueId, commit: () => void = () => undefined): Candidate {
    const rotation = this.state.rotation[id] ?? 0;
    return {
      cue: this.next(id, staticCueText(id, rotation), false),
      commit: () => {
        this.state.rotation[id] = rotation + 1;
        commit();
      },
    };
  }

  /** Called once when a run begins. */
  start(): Cue {
    return this.staticCue('run_start');
  }

  /** Called once when a run ends. */
  finish(metrics: RunMetrics): Cue[] {
    const summary = `${distanceLabel(metrics.distanceM, this.config.useMiles)} in ${durationLabel(
      metrics.elapsedMs,
    )}.`;
    return [this.staticCue('run_end'), this.next('run_end', summary, true)];
  }

  /**
   * Evaluates every rule and returns the single cue that has earned the ear,
   * or null. Candidates that lose are dropped rather than queued: a stale
   * warning is worse than silence.
   */
  update(input: CoachInput): Cue | null {
    const candidates = this.evaluate(input);
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.cue.priority - a.cue.priority);
    const chosen = candidates[0];
    const sinceLast = input.now - this.state.lastCueAt;
    if (sinceLast < this.config.minGapMs && chosen.cue.priority < PRIORITY.zone_high) return null;
    // Schedules only advance for the line that is actually spoken, so a cue
    // dropped by the gap rule comes back on the next tick.
    chosen.commit();
    this.state.lastCueAt = input.now;
    this.state.lastFiredAt[chosen.cue.id] = input.now;
    return chosen.cue;
  }

  private firedRecently(id: CueId, now: number, cooldownMs: number): boolean {
    const last = this.state.lastFiredAt[id];
    return last !== undefined && now - last < cooldownMs;
  }

  private evaluate(input: CoachInput): Candidate[] {
    const { now, metrics, target, zones } = input;
    const state = this.state;
    const config = this.config;
    const cues: Candidate[] = [];

    if (input.segmentLabel && input.segmentLabel !== state.lastSegmentLabel) {
      const label = input.segmentLabel;
      if (state.lastSegmentLabel === null) {
        state.lastSegmentLabel = label;
      } else {
        cues.push(
          this.candidate(this.next('segment_change', `Next: ${label}.`, true), () => {
            state.lastSegmentLabel = label;
          }),
        );
      }
    }

    const hrStale = metrics.heartRateAgeMs === null || metrics.heartRateAgeMs > HR_LOST_AFTER_MS;
    if (hrStale && !state.hrLost && metrics.elapsedMs > HR_LOST_AFTER_MS) {
      cues.push(this.staticCandidate('hr_lost', () => (state.hrLost = true)));
    } else if (!hrStale && state.hrLost) {
      cues.push(this.staticCandidate('hr_restored', () => (state.hrLost = false)));
    }

    if (metrics.heartRateBpm === null || target.type === 'rest') {
      // No qualifying signal, so no sustain window can be accruing.
      state.zoneHighSince = null;
      state.zoneLowSince = null;
    } else {
      const [low, high] = zoneRangeBpm(zones, target.zone);
      const bpm = metrics.heartRateBpm;
      if (bpm > high) {
        state.zoneLowSince = null;
        state.zoneHighSince ??= now;
        if (
          now - state.zoneHighSince >= config.zoneHighSustainMs &&
          !this.firedRecently('zone_high', now, 90_000)
        ) {
          cues.push(this.staticCandidate('zone_high', () => (state.outOfZone = true)));
        }
      } else if (bpm < low) {
        state.zoneHighSince = null;
        state.zoneLowSince ??= now;
        const onFlat = metrics.gradientPct < config.hillGradientPct;
        if (
          onFlat &&
          now - state.zoneLowSince >= config.zoneLowSustainMs &&
          !this.firedRecently('zone_low', now, 5 * 60_000)
        ) {
          cues.push(this.staticCandidate('zone_low', () => (state.outOfZone = true)));
        }
      } else {
        state.zoneHighSince = null;
        state.zoneLowSince = null;
        if (state.outOfZone) {
          cues.push(this.staticCandidate('zone_back', () => (state.outOfZone = false)));
        }
      }
    }

    if (metrics.gradientPct >= config.hillGradientPct) {
      state.descentSince = null;
      state.hillSince ??= now;
      if (
        now - state.hillSince >= config.gradientSustainMs &&
        !this.firedRecently('hill_hike', now, 4 * 60_000)
      ) {
        cues.push(this.staticCandidate('hill_hike'));
      }
    } else if (metrics.gradientPct <= config.descentGradientPct) {
      state.hillSince = null;
      state.descentSince ??= now;
      if (
        now - state.descentSince >= config.gradientSustainMs &&
        !this.firedRecently('descent', now, 6 * 60_000)
      ) {
        cues.push(this.staticCandidate('descent'));
      }
    } else {
      state.hillSince = null;
      state.descentSince = null;
    }

    if (config.fuellingEnabled) {
      if (state.lastFuelAt !== null && now - state.lastFuelAt >= config.fuelIntervalMs) {
        cues.push(this.staticCandidate('fuel', () => (state.lastFuelAt = now)));
      }
      if (state.lastDrinkAt !== null && now - state.lastDrinkAt >= config.drinkIntervalMs) {
        cues.push(this.staticCandidate('drink', () => (state.lastDrinkAt = now)));
      }
    }

    if (config.splitsEnabled && metrics.distanceM - state.lastSplitM >= config.splitEveryM) {
      const splitM = state.lastSplitM + config.splitEveryM;
      const pace = metrics.averagePaceSecPerKm;
      const text = `${distanceLabel(splitM, config.useMiles)}, ${durationLabel(metrics.elapsedMs)}${
        pace ? `, averaging ${paceLabel(pace, config.useMiles)}` : ''
      }.`;
      cues.push(this.candidate(this.next('split', text, true), () => (state.lastSplitM = splitM)));
    }

    const targetMs = target.durationMin * 60_000;
    if (!state.halfwayDone && targetMs > 0 && metrics.elapsedMs >= targetMs / 2) {
      cues.push(
        this.candidate(
          this.next('halfway', `Halfway. ${durationLabel(targetMs / 2)} to go.`, true),
          () => (state.halfwayDone = true),
        ),
      );
    }
    if (!state.targetDone && targetMs > 0 && metrics.elapsedMs >= targetMs) {
      cues.push(this.staticCandidate('target_reached', () => (state.targetDone = true)));
    }

    const drift = this.checkDrift(input);
    if (drift) cues.push(drift);

    return cues;
  }

  /**
   * Cardiac drift: heart rate climbing while pace holds is the earliest signal
   * that fuelling or heat is starting to cost you the back half of the run.
   */
  private checkDrift(input: CoachInput): Candidate | null {
    const { now, metrics } = input;
    const state = this.state;
    if (metrics.heartRateAvgBpm === null || metrics.paceSecPerKm === null) return null;
    const sample: DriftSample = {
      atMs: now,
      bpm: metrics.heartRateAvgBpm,
      paceSecPerKm: metrics.paceSecPerKm,
    };
    if (!state.driftBaseline) {
      if (metrics.elapsedMs > 8 * 60_000) state.driftBaseline = sample;
      return null;
    }
    const baseline = state.driftBaseline;
    if (now - baseline.atMs < DRIFT_MIN_INTERVAL_MS) return null;
    const paceDelta = Math.abs(sample.paceSecPerKm - baseline.paceSecPerKm) / baseline.paceSecPerKm;
    if (paceDelta > DRIFT_PACE_TOLERANCE) {
      state.driftBaseline = sample;
      return null;
    }
    const risePct = ((sample.bpm - baseline.bpm) / baseline.bpm) * 100;
    if (risePct < this.config.driftThresholdPct || this.firedRecently('cardiac_drift', now, 20 * 60_000)) {
      state.driftBaseline = sample;
      return null;
    }
    // The baseline only moves on if the warning is actually spoken, otherwise a
    // competing cue would bury the drift for another quarter of an hour.
    return this.staticCandidate('cardiac_drift', () => (state.driftBaseline = sample));
  }
}
