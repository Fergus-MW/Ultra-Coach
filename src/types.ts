export interface HeartRateSample {
  bpm: number;
  timestamp: number;
  contactDetected?: boolean;
  rrIntervalsMs?: number[];
  energyExpendedKj?: number;
}

export interface LocationSample {
  timestamp: number;
  latitude: number;
  longitude: number;
  altitude: number | null;
  /** Metres per second reported by the platform, when available. */
  speed: number | null;
  accuracy: number | null;
}

export type ZoneNumber = 1 | 2 | 3 | 4 | 5;

export interface RunMetrics {
  elapsedMs: number;
  movingMs: number;
  distanceM: number;
  elevationGainM: number;
  elevationLossM: number;
  /** Smoothed instantaneous pace in seconds per kilometre, null until it settles. */
  paceSecPerKm: number | null;
  averagePaceSecPerKm: number | null;
  /** Smoothed gradient as a percentage, positive uphill. */
  gradientPct: number;
  heartRateBpm: number | null;
  /** Rolling 60 second average heart rate. */
  heartRateAvgBpm: number | null;
  zone: ZoneNumber | null;
  /** Milliseconds since the last heart rate sample, null when none has arrived. */
  heartRateAgeMs: number | null;
}

export type SessionType = 'easy' | 'long' | 'tempo' | 'intervals' | 'hills' | 'recovery' | 'rest';

export interface SessionSegment {
  label: string;
  durationMin: number;
  targetZone: ZoneNumber;
}

export interface PlannedSession {
  id: string;
  /** Days from the start of the plan. */
  dayIndex: number;
  weekIndex: number;
  type: SessionType;
  title: string;
  durationMin: number;
  targetZone: ZoneNumber;
  notes: string;
  segments?: SessionSegment[];
}

export interface PlanWeek {
  index: number;
  volumeMin: number;
  phase: 'base' | 'build' | 'peak' | 'taper' | 'race';
  isDownWeek: boolean;
  sessions: PlannedSession[];
}

export interface TrainingPlan {
  createdAt: number;
  raceName: string;
  raceDateIso: string;
  raceDistanceKm: number;
  weeks: PlanWeek[];
}

export interface HeartRateZones {
  maxHr: number;
  restingHr: number;
  /** Lower bound of each zone as a fraction of heart rate reserve. */
  bounds: Record<ZoneNumber, number>;
}

export interface CompletedRun {
  id: string;
  startedAt: number;
  endedAt: number;
  sessionId: string | null;
  sessionTitle: string;
  metrics: RunMetrics;
  timeInZoneMs: Record<ZoneNumber, number>;
  cues: { at: number; cueId: string; text: string }[];
}
