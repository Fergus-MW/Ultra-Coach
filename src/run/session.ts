import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { create } from 'zustand';
import { CoachEngine, type CoachInput, type SessionTarget } from '../coach/engine';
import type { Cue } from '../coach/cues';
import { RunTracker } from '../metrics';
import {
  BleHeartRateSource,
  SimulatedHeartRateSource,
  type HeartRateSource,
  type HeartRateSourceState,
} from '../sensors/heartRate';
import { GpsLocationSource, SimulatedLocationSource, type LocationSource } from '../sensors/location';
import type { Settings } from '../store/settings';
import { voiceConfigFrom } from '../store/settings';
import { useRuns } from '../store/runs';
import type { CompletedRun, PlannedSession, RunMetrics, SessionSegment, ZoneNumber } from '../types';
import { Speaker } from '../voice/speaker';

export type RunStatus = 'idle' | 'running' | 'paused' | 'finished';

export interface CueLogEntry {
  at: number;
  cueId: string;
  text: string;
}

const EMPTY_METRICS: RunMetrics = {
  elapsedMs: 0,
  movingMs: 0,
  distanceM: 0,
  elevationGainM: 0,
  elevationLossM: 0,
  paceSecPerKm: null,
  averagePaceSecPerKm: null,
  gradientPct: 0,
  heartRateBpm: null,
  heartRateAvgBpm: null,
  zone: null,
  heartRateAgeMs: null,
};

interface RunStore {
  status: RunStatus;
  metrics: RunMetrics;
  target: SessionTarget | null;
  segmentLabel: string | null;
  heartRate: HeartRateSourceState;
  cues: CueLogEntry[];
  locationError: string | null;
  simulated: boolean;
  set: (patch: Partial<RunStore>) => void;
}

export const useRunStore = create<RunStore>((set) => ({
  status: 'idle',
  metrics: EMPTY_METRICS,
  target: null,
  segmentLabel: null,
  heartRate: { status: 'idle', deviceName: null, deviceId: null, message: null },
  cues: [],
  locationError: null,
  simulated: false,
  set: (patch) => set(patch),
}));

export function segmentAt(segments: SessionSegment[] | undefined, elapsedMs: number): SessionSegment | null {
  if (!segments || segments.length === 0) return null;
  let cursor = 0;
  for (const segment of segments) {
    cursor += segment.durationMin * 60_000;
    if (elapsedMs < cursor) return segment;
  }
  return segments[segments.length - 1];
}

function targetFor(session: PlannedSession | null): SessionTarget {
  if (!session) {
    return { zone: 2 as ZoneNumber, durationMin: 0, type: 'easy', label: 'Free run' };
  }
  return {
    zone: session.targetZone,
    durationMin: session.durationMin,
    type: session.type,
    label: session.title,
  };
}

const TICK_MS = 1000;

/**
 * Wires sensors to the rules engine to the ear. One instance for the app; the
 * UI reads `useRunStore` and never touches the sensors directly.
 */
class RunSessionController {
  private tracker: RunTracker | null = null;
  private engine: CoachEngine | null = null;
  private speaker = new Speaker();
  private hrSource: HeartRateSource | null = null;
  private locationSource: LocationSource | null = null;
  private unsubscribeHrState: (() => void) | null = null;
  private unsubscribeHrSample: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private pausedAt: number | null = null;
  private pausedMs = 0;
  private session: PlannedSession | null = null;
  private cueLog: CueLogEntry[] = [];
  private settings: Settings | null = null;

  get isActive(): boolean {
    return this.timer !== null;
  }

  applySettings(settings: Settings, apiKey: string): void {
    this.settings = settings;
    this.speaker.setOptions({
      voice: voiceConfigFrom(settings, apiKey),
      allowLiveSynthesis: settings.allowLiveSynthesis,
      allowDeviceFallback: settings.allowDeviceFallback,
      volume: settings.volume,
    });
    this.tracker?.setZones(settings.zones);
    this.engine?.setConfig(settings.coach);
  }

  async start(session: PlannedSession | null, settings: Settings, apiKey: string): Promise<void> {
    if (this.isActive) return;
    this.applySettings(settings, apiKey);
    this.session = session;
    this.startedAt = Date.now();
    this.pausedMs = 0;
    this.pausedAt = null;
    this.cueLog = [];
    this.tracker = new RunTracker(this.startedAt, settings.zones);
    this.engine = new CoachEngine(this.startedAt, settings.coach);

    useRunStore.getState().set({
      status: 'running',
      metrics: EMPTY_METRICS,
      target: targetFor(session),
      segmentLabel: null,
      cues: [],
      locationError: null,
      simulated: settings.useSimulators,
    });

    await activateKeepAwakeAsync('ultra-coach-run').catch(() => undefined);

    this.hrSource = settings.useSimulators ? new SimulatedHeartRateSource() : new BleHeartRateSource();
    this.unsubscribeHrState = this.hrSource.onState((state) => useRunStore.getState().set({ heartRate: state }));
    this.unsubscribeHrSample = this.hrSource.onSample((sample) => this.tracker?.addHeartRate(sample));
    await this.hrSource.start(settings.preferredDeviceId);

    this.locationSource = settings.useSimulators ? new SimulatedLocationSource() : new GpsLocationSource();
    const error = await this.locationSource.start((sample) => this.tracker?.addLocation(sample));
    if (error) useRunStore.getState().set({ locationError: error });

    this.speak(this.engine.start());
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  private speak(cue: Cue): void {
    const entry = { at: Date.now(), cueId: cue.id, text: cue.text };
    this.cueLog = [entry, ...this.cueLog].slice(0, 200);
    useRunStore.getState().set({ cues: this.cueLog });
    this.speaker.enqueue(cue);
  }

  /** Speaks an ad hoc line, used by the manual cue buttons. */
  say(cue: Cue): void {
    this.speak(cue);
  }

  /** Drives the synthetic athlete harder or easier while testing without a strap. */
  setSimulatedEffort(bias: number): void {
    if (this.hrSource instanceof SimulatedHeartRateSource) this.hrSource.setEffortBias(bias);
  }

  /** Cues stay quiet while the conversational agent has the microphone. */
  setVoiceSuppressed(suppressed: boolean): void {
    this.speaker.setSuppressed(suppressed);
  }

  /** Snapshot of the run in words, handed to the agent as context. */
  contextSummary(): string {
    const { metrics, target } = useRunStore.getState();
    const parts = [
      `Session: ${target?.label ?? 'free run'} targeting zone ${target?.zone ?? 2}.`,
      `Elapsed ${Math.round(metrics.elapsedMs / 60_000)} min, distance ${(metrics.distanceM / 1000).toFixed(2)} km.`,
      metrics.heartRateBpm ? `Heart rate ${metrics.heartRateBpm} bpm, zone ${metrics.zone ?? '?'}.` : 'No heart rate signal.',
      metrics.paceSecPerKm
        ? `Current pace ${Math.floor(metrics.paceSecPerKm / 60)}:${String(Math.round(metrics.paceSecPerKm % 60)).padStart(2, '0')} per km.`
        : 'Pace not settled.',
      `Gradient ${metrics.gradientPct.toFixed(1)} percent, climbed ${Math.round(metrics.elevationGainM)} m.`,
    ];
    return parts.join(' ');
  }

  private tick(): void {
    if (!this.tracker || !this.engine || !this.settings) return;
    const store = useRunStore.getState();
    if (store.status === 'paused') return;
    const now = Date.now();
    const metrics = this.tracker.metrics(now);
    const adjusted: RunMetrics = { ...metrics, elapsedMs: metrics.elapsedMs - this.pausedMs };
    const segment = segmentAt(this.session?.segments, adjusted.elapsedMs);
    const base = targetFor(this.session);
    const target: SessionTarget = segment ? { ...base, zone: segment.targetZone } : base;

    const input: CoachInput = {
      now,
      metrics: adjusted,
      target,
      zones: this.settings.zones,
      segmentLabel: segment?.label,
    };
    const cue = this.engine.update(input);
    store.set({ metrics: adjusted, target, segmentLabel: segment?.label ?? null });
    if (cue) this.speak(cue);
  }

  pause(): void {
    if (useRunStore.getState().status !== 'running') return;
    this.pausedAt = Date.now();
    this.speaker.stop();
    useRunStore.getState().set({ status: 'paused' });
  }

  resume(): void {
    if (useRunStore.getState().status !== 'paused') return;
    if (this.pausedAt) this.pausedMs += Date.now() - this.pausedAt;
    this.pausedAt = null;
    useRunStore.getState().set({ status: 'running' });
  }

  async stop(): Promise<CompletedRun | null> {
    if (!this.tracker || !this.engine) return null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const now = Date.now();
    const metrics: RunMetrics = {
      ...this.tracker.metrics(now),
      elapsedMs: this.tracker.metrics(now).elapsedMs - this.pausedMs,
    };
    this.engine.finish(metrics).forEach((cue) => this.speak(cue));

    const run: CompletedRun = {
      id: `run-${this.startedAt}`,
      startedAt: this.startedAt,
      endedAt: now,
      sessionId: this.session?.id ?? null,
      sessionTitle: this.session?.title ?? 'Free run',
      metrics,
      timeInZoneMs: this.tracker.getTimeInZoneMs(),
      cues: [...this.cueLog].reverse(),
    };

    this.unsubscribeHrSample?.();
    this.unsubscribeHrState?.();
    await this.hrSource?.stop();
    await this.locationSource?.stop();
    this.hrSource = null;
    this.locationSource = null;
    this.tracker = null;
    this.engine = null;
    deactivateKeepAwake('ultra-coach-run');

    useRunStore.getState().set({ status: 'finished', metrics });
    await useRuns.getState().save(run);
    return run;
  }

  reset(): void {
    this.speaker.stop();
    useRunStore.getState().set({ status: 'idle', metrics: EMPTY_METRICS, cues: [], segmentLabel: null });
  }
}

export const runSession = new RunSessionController();
