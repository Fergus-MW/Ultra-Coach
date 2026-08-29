import { PermissionsAndroid, Platform } from 'react-native';
import type { Device } from 'react-native-ble-plx';
import type { HeartRateSample } from '../types';
import { parseHeartRateBase64 } from './hrParser';

export const HEART_RATE_SERVICE_UUID = '0000180d-0000-1000-8000-00805f9b34fb';
export const HEART_RATE_MEASUREMENT_UUID = '00002a37-0000-1000-8000-00805f9b34fb';

export type HeartRateStatus = 'idle' | 'scanning' | 'connecting' | 'connected' | 'unavailable' | 'error';

export interface HeartRateSourceState {
  status: HeartRateStatus;
  deviceName: string | null;
  deviceId: string | null;
  message: string | null;
}

export type SampleListener = (sample: HeartRateSample) => void;
export type StateListener = (state: HeartRateSourceState) => void;

export interface HeartRateSource {
  readonly state: HeartRateSourceState;
  start(preferredDeviceId?: string | null): Promise<void>;
  stop(): Promise<void>;
  onSample(listener: SampleListener): () => void;
  onState(listener: StateListener): () => void;
}

abstract class BaseHeartRateSource implements HeartRateSource {
  protected sampleListeners = new Set<SampleListener>();
  protected stateListeners = new Set<StateListener>();
  state: HeartRateSourceState = { status: 'idle', deviceName: null, deviceId: null, message: null };

  onSample(listener: SampleListener): () => void {
    this.sampleListeners.add(listener);
    return () => this.sampleListeners.delete(listener);
  }

  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  protected emitSample(sample: HeartRateSample): void {
    this.sampleListeners.forEach((listener) => listener(sample));
  }

  protected setState(patch: Partial<HeartRateSourceState>): void {
    this.state = { ...this.state, ...patch };
    this.stateListeners.forEach((listener) => listener(this.state));
  }

  abstract start(preferredDeviceId?: string | null): Promise<void>;
  abstract stop(): Promise<void>;
}

async function requestAndroidPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const permissions =
    Number(Platform.Version) >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        ]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
  const result = await PermissionsAndroid.requestMultiple(permissions);
  return permissions.every((permission) => result[permission] === PermissionsAndroid.RESULTS.GRANTED);
}

const SCAN_TIMEOUT_MS = 20_000;

/** Live heart rate straight off the strap over the standard Heart Rate Profile. */
export class BleHeartRateSource extends BaseHeartRateSource {
  private manager: import('react-native-ble-plx').BleManager | null = null;
  private device: Device | null = null;
  private scanTimeout: ReturnType<typeof setTimeout> | null = null;
  private monitorSubscription: { remove: () => void } | null = null;

  private getManager(): import('react-native-ble-plx').BleManager | null {
    if (this.manager) return this.manager;
    try {
      // Required lazily: the native module is absent in Expo Go and on web.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { BleManager } = require('react-native-ble-plx') as typeof import('react-native-ble-plx');
      this.manager = new BleManager();
      return this.manager;
    } catch {
      return null;
    }
  }

  async start(preferredDeviceId?: string | null): Promise<void> {
    const manager = this.getManager();
    if (!manager) {
      this.setState({ status: 'unavailable', message: 'Bluetooth needs a development build.' });
      return;
    }
    const granted = await requestAndroidPermissions();
    if (!granted) {
      this.setState({ status: 'error', message: 'Bluetooth permission denied.' });
      return;
    }

    if (preferredDeviceId) {
      try {
        const [known] = await manager.devices([preferredDeviceId]);
        if (known) {
          await this.connect(known);
          return;
        }
      } catch {
        // Fall through to a scan.
      }
    }

    this.setState({ status: 'scanning', message: 'Looking for a heart rate strap…' });
    this.scanTimeout = setTimeout(() => {
      manager.stopDeviceScan();
      if (this.state.status === 'scanning') {
        this.setState({ status: 'error', message: 'No heart rate device found.' });
      }
    }, SCAN_TIMEOUT_MS);

    manager.startDeviceScan([HEART_RATE_SERVICE_UUID], { allowDuplicates: false }, (error, device) => {
      if (error) {
        this.setState({ status: 'error', message: error.message });
        return;
      }
      if (!device) return;
      if (preferredDeviceId && device.id !== preferredDeviceId) return;
      manager.stopDeviceScan();
      this.clearScanTimeout();
      void this.connect(device);
    });
  }

  private clearScanTimeout(): void {
    if (this.scanTimeout) {
      clearTimeout(this.scanTimeout);
      this.scanTimeout = null;
    }
  }

  private async connect(device: Device): Promise<void> {
    try {
      this.setState({
        status: 'connecting',
        deviceName: device.name ?? device.localName ?? 'Heart rate strap',
        deviceId: device.id,
        message: null,
      });
      const connected = await device.connect({ autoConnect: true });
      await connected.discoverAllServicesAndCharacteristics();
      this.device = connected;
      this.monitorSubscription = connected.monitorCharacteristicForService(
        HEART_RATE_SERVICE_UUID,
        HEART_RATE_MEASUREMENT_UUID,
        (error, characteristic) => {
          if (error) {
            this.setState({ status: 'error', message: error.message });
            return;
          }
          if (!characteristic?.value) return;
          const measurement = parseHeartRateBase64(characteristic.value);
          if (!measurement || measurement.bpm <= 0) return;
          this.emitSample({
            bpm: measurement.bpm,
            timestamp: Date.now(),
            contactDetected: measurement.contactDetected,
            rrIntervalsMs: measurement.rrIntervalsMs,
            energyExpendedKj: measurement.energyExpendedKj,
          });
        },
      );
      this.setState({ status: 'connected', message: null });
    } catch (error) {
      this.setState({ status: 'error', message: (error as Error).message });
    }
  }

  async stop(): Promise<void> {
    this.clearScanTimeout();
    this.monitorSubscription?.remove();
    this.monitorSubscription = null;
    this.manager?.stopDeviceScan();
    if (this.device) {
      try {
        await this.device.cancelConnection();
      } catch {
        // Already gone.
      }
      this.device = null;
    }
    this.setState({ status: 'idle', message: null });
  }
}

export interface SimulatedProfile {
  /** Effort as a fraction of heart rate reserve over the run, sampled by minute. */
  baseFraction: number;
  driftPerHour: number;
  restingHr: number;
  maxHr: number;
}

export const DEFAULT_SIMULATED_PROFILE: SimulatedProfile = {
  baseFraction: 0.65,
  driftPerHour: 0.05,
  restingHr: 50,
  maxHr: 190,
};

/**
 * A synthetic strap. Makes the whole coaching loop demonstrable on an emulator
 * and gives the rules engine something to react to without a real run.
 */
export class SimulatedHeartRateSource extends BaseHeartRateSource {
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private profile: SimulatedProfile;
  private effortBias = 0;

  constructor(profile: SimulatedProfile = DEFAULT_SIMULATED_PROFILE) {
    super();
    this.profile = profile;
  }

  /** Nudges simulated effort, so the UI can provoke a zone warning on demand. */
  setEffortBias(bias: number): void {
    this.effortBias = bias;
  }

  async start(): Promise<void> {
    this.startedAt = Date.now();
    this.setState({ status: 'connected', deviceName: 'Simulator', deviceId: 'sim', message: null });
    this.timer = setInterval(() => {
      const elapsedHours = (Date.now() - this.startedAt) / 3_600_000;
      const wobble = Math.sin(Date.now() / 20_000) * 0.02 + (Math.random() - 0.5) * 0.01;
      const fraction = Math.max(
        0.3,
        Math.min(
          0.98,
          this.profile.baseFraction + this.effortBias + this.profile.driftPerHour * elapsedHours + wobble,
        ),
      );
      const bpm = Math.round(
        this.profile.restingHr + (this.profile.maxHr - this.profile.restingHr) * fraction,
      );
      this.emitSample({ bpm, timestamp: Date.now(), contactDetected: true });
    }, 2000);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.setState({ status: 'idle' });
  }
}
