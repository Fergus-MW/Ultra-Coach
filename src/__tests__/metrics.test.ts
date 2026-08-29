import {
  DEFAULT_ZONES,
  RunTracker,
  formatDuration,
  formatPace,
  haversineMetres,
  zoneForBpm,
  zoneRangeBpm,
} from '../metrics';
import type { LocationSample } from '../types';

const START = 1_700_000_000_000;

function point(index: number, altitude: number, latStepM = 3): LocationSample {
  return {
    timestamp: START + index * 1000,
    latitude: 51.45 + (index * latStepM) / 111_320,
    longitude: -2.58,
    altitude,
    speed: latStepM,
    accuracy: 5,
  };
}

describe('geo and formatting', () => {
  it('measures a short north step', () => {
    const metres = haversineMetres(point(0, 0), point(1, 0));
    expect(metres).toBeGreaterThan(2.9);
    expect(metres).toBeLessThan(3.1);
  });

  it('formats pace and duration', () => {
    expect(formatPace(330)).toBe('5:30');
    expect(formatPace(null)).toBe('--:--');
    expect(formatDuration(65_000)).toBe('01:05');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
  });
});

describe('zones', () => {
  it('maps bpm onto Karvonen zones', () => {
    expect(zoneForBpm(DEFAULT_ZONES, 100)).toBe(1);
    expect(zoneForBpm(DEFAULT_ZONES, 140)).toBe(2);
    expect(zoneForBpm(DEFAULT_ZONES, 180)).toBe(5);
    expect(zoneForBpm(DEFAULT_ZONES, 0)).toBeNull();
  });

  it('gives contiguous ranges topping out at max HR', () => {
    const [, highOfTwo] = zoneRangeBpm(DEFAULT_ZONES, 2);
    const [lowOfThree] = zoneRangeBpm(DEFAULT_ZONES, 3);
    expect(lowOfThree - highOfTwo).toBe(1);
    expect(zoneRangeBpm(DEFAULT_ZONES, 5)[1]).toBe(DEFAULT_ZONES.maxHr);
  });
});

describe('RunTracker', () => {
  it('accumulates distance, pace and elevation', () => {
    const tracker = new RunTracker(START);
    for (let index = 0; index <= 60; index += 1) {
      tracker.addLocation(point(index, 100 + index));
    }
    const metrics = tracker.metrics(START + 60_000);
    expect(metrics.distanceM).toBeGreaterThan(170);
    expect(metrics.distanceM).toBeLessThan(190);
    // 3 m/s is 5:33 per km.
    expect(metrics.paceSecPerKm).toBeGreaterThan(300);
    expect(metrics.paceSecPerKm).toBeLessThan(380);
    expect(metrics.elevationGainM).toBeGreaterThan(40);
    expect(metrics.elevationLossM).toBe(0);
    expect(metrics.gradientPct).toBeGreaterThan(20);
  });

  it('ignores samples with poor accuracy', () => {
    const tracker = new RunTracker(START);
    tracker.addLocation(point(0, 100));
    tracker.addLocation({ ...point(1, 100), accuracy: 120 });
    tracker.addLocation(point(2, 100));
    const metrics = tracker.metrics(START + 2000);
    expect(metrics.distanceM).toBeGreaterThan(5.5);
    expect(metrics.distanceM).toBeLessThan(6.5);
  });

  it('tracks heart rate freshness and time in zone', () => {
    const tracker = new RunTracker(START);
    tracker.addHeartRate({ bpm: 150, timestamp: START + 1000 });
    tracker.addHeartRate({ bpm: 152, timestamp: START + 11_000 });
    const metrics = tracker.metrics(START + 12_000);
    expect(metrics.heartRateBpm).toBe(152);
    expect(metrics.zone).toBe(3);
    expect(metrics.heartRateAgeMs).toBe(1000);
    expect(tracker.getTimeInZoneMs()[3]).toBeGreaterThan(0);
  });

  it('credits each interval to the zone it was actually spent in', () => {
    const tracker = new RunTracker(START);
    // Zone 2 for ten seconds, then zone 3 for ten seconds, then back.
    tracker.addHeartRate({ bpm: 140, timestamp: START });
    tracker.addHeartRate({ bpm: 160, timestamp: START + 10_000 });
    tracker.addHeartRate({ bpm: 140, timestamp: START + 20_000 });
    tracker.addHeartRate({ bpm: 140, timestamp: START + 25_000 });
    const timeInZone = tracker.getTimeInZoneMs();
    expect(zoneForBpm(DEFAULT_ZONES, 140)).toBe(2);
    expect(zoneForBpm(DEFAULT_ZONES, 160)).toBe(3);
    expect(timeInZone[2]).toBe(15_000);
    expect(timeInZone[3]).toBe(10_000);
  });

  it('ignores samples arriving while paused and does not bridge the gap', () => {
    const tracker = new RunTracker(START);
    tracker.addLocation(point(0, 100));
    tracker.addHeartRate({ bpm: 150, timestamp: START });
    tracker.setPaused(true);
    for (let index = 1; index <= 30; index += 1) {
      tracker.addLocation(point(index, 100 + index));
      tracker.addHeartRate({ bpm: 150, timestamp: START + index * 1000 });
    }
    tracker.setPaused(false);
    tracker.addLocation(point(31, 131));
    tracker.addHeartRate({ bpm: 150, timestamp: START + 31_000 });

    const metrics = tracker.metrics(START + 31_000);
    expect(metrics.distanceM).toBe(0);
    expect(metrics.movingMs).toBe(0);
    expect(metrics.elevationGainM).toBe(0);
    expect(tracker.getTimeInZoneMs()[3]).toBe(0);
  });
});
