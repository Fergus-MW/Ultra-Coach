import * as Location from 'expo-location';
import type { LocationSample } from '../types';

export type LocationListener = (sample: LocationSample) => void;

export interface LocationSource {
  start(listener: LocationListener): Promise<string | null>;
  stop(): Promise<void>;
}

export class GpsLocationSource implements LocationSource {
  private subscription: Location.LocationSubscription | null = null;

  async start(listener: LocationListener): Promise<string | null> {
    const foreground = await Location.requestForegroundPermissionsAsync();
    if (!foreground.granted) return 'Location permission denied.';
    // Background permission keeps the track alive with the screen off; a denial
    // is survivable, so it never blocks the run.
    await Location.requestBackgroundPermissionsAsync().catch(() => undefined);

    this.subscription = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: 1000,
        distanceInterval: 2,
      },
      (position) => {
        listener({
          timestamp: position.timestamp,
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          altitude: position.coords.altitude,
          speed: position.coords.speed,
          accuracy: position.coords.accuracy,
        });
      },
    );
    return null;
  }

  async stop(): Promise<void> {
    this.subscription?.remove();
    this.subscription = null;
  }
}

const METRES_PER_DEGREE_LAT = 111_320;

/** A looping synthetic route with two climbs, for emulator runs. */
export class SimulatedLocationSource implements LocationSource {
  private timer: ReturnType<typeof setInterval> | null = null;
  private elapsedS = 0;
  private latitude = 51.4545;
  private longitude = -2.5879;

  async start(listener: LocationListener): Promise<string | null> {
    this.elapsedS = 0;
    this.timer = setInterval(() => {
      this.elapsedS += 1;
      const speedMps = 3.1 + Math.sin(this.elapsedS / 90) * 0.3;
      this.latitude += speedMps / METRES_PER_DEGREE_LAT;
      const altitude = 60 + Math.sin(this.elapsedS / 120) * 35;
      listener({
        timestamp: Date.now(),
        latitude: this.latitude,
        longitude: this.longitude,
        altitude,
        speed: speedMps,
        accuracy: 5,
      });
    }, 1000);
    return null;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
