import type { HeartRateSample, HeartRateZones, LocationSample, RunMetrics, ZoneNumber } from './types';

export const DEFAULT_ZONES: HeartRateZones = {
  maxHr: 190,
  restingHr: 50,
  bounds: { 1: 0.5, 2: 0.6, 3: 0.7, 4: 0.8, 5: 0.9 },
};

const EARTH_RADIUS_M = 6371008.8;

export function haversineMetres(a: LocationSample, b: LocationSample): number {
  const toRad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * toRad;
  const dLon = (b.longitude - a.longitude) * toRad;
  const lat1 = a.latitude * toRad;
  const lat2 = b.latitude * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Heart rate at a given fraction of heart rate reserve (Karvonen). */
export function bpmAtReserveFraction(zones: HeartRateZones, fraction: number): number {
  return Math.round(zones.restingHr + (zones.maxHr - zones.restingHr) * fraction);
}

export function zoneRangeBpm(zones: HeartRateZones, zone: ZoneNumber): [number, number] {
  const lower = bpmAtReserveFraction(zones, zones.bounds[zone]);
  const upper =
    zone === 5 ? zones.maxHr : bpmAtReserveFraction(zones, zones.bounds[(zone + 1) as ZoneNumber]) - 1;
  return [lower, Math.max(lower, upper)];
}

export function zoneForBpm(zones: HeartRateZones, bpm: number): ZoneNumber | null {
  if (!Number.isFinite(bpm) || bpm <= 0) return null;
  let current: ZoneNumber = 1;
  for (const zone of [1, 2, 3, 4, 5] as ZoneNumber[]) {
    if (bpm >= bpmAtReserveFraction(zones, zones.bounds[zone])) current = zone;
  }
  return current;
}

export function formatPace(secPerKm: number | null): string {
  if (secPerKm === null || !Number.isFinite(secPerKm) || secPerKm <= 0) return '--:--';
  const capped = Math.min(secPerKm, 59 * 60 + 59);
  const minutes = Math.floor(capped / 60);
  const seconds = Math.round(capped % 60);
  const carry = seconds === 60;
  return `${carry ? minutes + 1 : minutes}:${String(carry ? 0 : seconds).padStart(2, '0')}`;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

const MIN_STEP_M = 1.5;
const MAX_ACCURACY_M = 35;
const MOVING_SPEED_MPS = 0.5;
const PACE_WINDOW_MS = 20_000;
const GRADIENT_WINDOW_M = 40;
const HR_AVERAGE_WINDOW_MS = 60_000;
const ALTITUDE_SMOOTHING = 5;
const ELEVATION_THRESHOLD_M = 1;

interface TrackPoint {
  timestamp: number;
  cumulativeM: number;
  altitude: number | null;
  smoothedAltitude: number | null;
}

/**
 * Accumulates raw sensor samples into the derived metrics the coach reasons about.
 * Deterministic: every method takes the timestamps from the samples themselves.
 */
export class RunTracker {
  private zones: HeartRateZones;
  private startedAt: number;
  private track: TrackPoint[] = [];
  private lastLocation: LocationSample | null = null;
  private rawAltitudes: number[] = [];
  private referenceAltitude: number | null = null;
  private heartRates: HeartRateSample[] = [];
  private distanceM = 0;
  private movingMs = 0;
  private gainM = 0;
  private lossM = 0;
  private timeInZoneMs: Record<ZoneNumber, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  private lastZoneAt: number | null = null;
  private lastZone: ZoneNumber | null = null;
  private paused = false;

  constructor(startedAt: number, zones: HeartRateZones = DEFAULT_ZONES) {
    this.startedAt = startedAt;
    this.zones = zones;
  }

  setZones(zones: HeartRateZones): void {
    this.zones = zones;
  }

  /**
   * Samples arriving while paused are dropped, and continuity is broken on
   * resume so the gap is not billed as distance or time in zone.
   */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) return;
    this.lastLocation = null;
    this.lastZoneAt = null;
    this.lastZone = null;
    this.rawAltitudes = [];
    this.referenceAltitude = null;
  }

  addLocation(sample: LocationSample): void {
    if (this.paused) return;
    if (sample.accuracy !== null && sample.accuracy > MAX_ACCURACY_M) return;
    const previous = this.lastLocation;
    if (previous) {
      const step = haversineMetres(previous, sample);
      const dtMs = sample.timestamp - previous.timestamp;
      if (dtMs <= 0) return;
      if (step >= MIN_STEP_M) {
        this.distanceM += step;
        const speed = step / (dtMs / 1000);
        if (speed >= MOVING_SPEED_MPS) this.movingMs += dtMs;
      }
    }
    this.lastLocation = sample;

    let smoothedAltitude: number | null = null;
    if (sample.altitude !== null) {
      this.rawAltitudes.push(sample.altitude);
      if (this.rawAltitudes.length > ALTITUDE_SMOOTHING) this.rawAltitudes.shift();
      smoothedAltitude =
        this.rawAltitudes.reduce((sum, value) => sum + value, 0) / this.rawAltitudes.length;
      if (this.referenceAltitude === null) {
        this.referenceAltitude = smoothedAltitude;
      } else {
        const delta = smoothedAltitude - this.referenceAltitude;
        if (delta >= ELEVATION_THRESHOLD_M) {
          this.gainM += delta;
          this.referenceAltitude = smoothedAltitude;
        } else if (delta <= -ELEVATION_THRESHOLD_M) {
          this.lossM += -delta;
          this.referenceAltitude = smoothedAltitude;
        }
      }
    }

    this.track.push({
      timestamp: sample.timestamp,
      cumulativeM: this.distanceM,
      altitude: sample.altitude,
      smoothedAltitude,
    });
    while (this.track.length > 2 && this.track[0].timestamp < sample.timestamp - 5 * 60_000) {
      this.track.shift();
    }
  }

  addHeartRate(sample: HeartRateSample): void {
    if (this.paused) return;
    this.heartRates.push(sample);
    // The interval that just elapsed was spent in the zone of the *previous*
    // sample, not the one that has only now arrived.
    if (this.lastZone !== null && this.lastZoneAt !== null) {
      const dt = sample.timestamp - this.lastZoneAt;
      if (dt > 0 && dt < 30_000) this.timeInZoneMs[this.lastZone] += dt;
    }
    this.lastZone = zoneForBpm(this.zones, sample.bpm);
    this.lastZoneAt = sample.timestamp;
    while (this.heartRates.length > 1 && this.heartRates[0].timestamp < sample.timestamp - 30 * 60_000) {
      this.heartRates.shift();
    }
  }

  getTimeInZoneMs(): Record<ZoneNumber, number> {
    return { ...this.timeInZoneMs };
  }

  /** Mean heart rate over a trailing window, used for cardiac drift detection. */
  averageHeartRate(now: number, windowMs: number, offsetMs = 0): number | null {
    const end = now - offsetMs;
    const start = end - windowMs;
    const inWindow = this.heartRates.filter((s) => s.timestamp > start && s.timestamp <= end);
    if (inWindow.length === 0) return null;
    return inWindow.reduce((sum, s) => sum + s.bpm, 0) / inWindow.length;
  }

  private instantPace(now: number): number | null {
    if (this.track.length < 2) return null;
    const end = this.track[this.track.length - 1];
    const cutoff = end.timestamp - PACE_WINDOW_MS;
    let start = this.track[0];
    for (const point of this.track) {
      if (point.timestamp <= cutoff) start = point;
      else break;
    }
    const dtMs = end.timestamp - start.timestamp;
    const dM = end.cumulativeM - start.cumulativeM;
    if (dtMs < 5_000 || dM < 5) return null;
    if (now - end.timestamp > 15_000) return null;
    return (dtMs / 1000 / dM) * 1000;
  }

  private gradient(): number {
    if (this.track.length < 2) return 0;
    const end = this.track[this.track.length - 1];
    if (end.smoothedAltitude === null) return 0;
    let start: TrackPoint | null = null;
    for (let i = this.track.length - 2; i >= 0; i -= 1) {
      const point = this.track[i];
      if (point.smoothedAltitude === null) continue;
      start = point;
      if (end.cumulativeM - point.cumulativeM >= GRADIENT_WINDOW_M) break;
    }
    if (!start || start.smoothedAltitude === null) return 0;
    const run = end.cumulativeM - start.cumulativeM;
    if (run < GRADIENT_WINDOW_M / 2) return 0;
    const rise = end.smoothedAltitude - start.smoothedAltitude;
    return Math.max(-40, Math.min(40, (rise / run) * 100));
  }

  metrics(now: number): RunMetrics {
    const elapsedMs = Math.max(0, now - this.startedAt);
    const latestHr = this.heartRates[this.heartRates.length - 1] ?? null;
    const heartRateAgeMs = latestHr ? now - latestHr.timestamp : null;
    const fresh = latestHr !== null && heartRateAgeMs !== null && heartRateAgeMs < 15_000;
    const bpm = fresh ? latestHr.bpm : null;
    return {
      elapsedMs,
      movingMs: this.movingMs,
      distanceM: this.distanceM,
      elevationGainM: this.gainM,
      elevationLossM: this.lossM,
      paceSecPerKm: this.instantPace(now),
      averagePaceSecPerKm:
        this.distanceM > 50 && this.movingMs > 0 ? (this.movingMs / 1000 / this.distanceM) * 1000 : null,
      gradientPct: this.gradient(),
      heartRateBpm: bpm,
      heartRateAvgBpm: this.averageHeartRate(now, HR_AVERAGE_WINDOW_MS),
      zone: bpm === null ? null : zoneForBpm(this.zones, bpm),
      heartRateAgeMs,
    };
  }
}
