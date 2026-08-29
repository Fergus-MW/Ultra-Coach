import { runSession, useRunStore } from '../run/session';
import { DEFAULT_SETTINGS } from '../store/settings';
import { useRuns } from '../store/runs';

jest.mock('@react-native-async-storage/async-storage', () =>
  // The library ships its own Jest mock; jest.mock factories cannot use imports.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(),
}));

jest.mock('../voice/speaker', () => ({
  Speaker: class {
    setOptions(): void {}
    setSuppressed(): void {}
    enqueue(): void {}
    stop(): void {}
  },
}));

describe('run session pausing', () => {
  beforeEach(() => {
    useRuns.setState({ ...useRuns.getState(), runs: [], save: async () => undefined });
  });

  it('excludes a pause that is still open when the run finishes', async () => {
    jest.useFakeTimers();
    const settings = { ...DEFAULT_SETTINGS, useSimulators: true };
    await runSession.start(null, settings, '');

    jest.advanceTimersByTime(60_000);
    runSession.pause();
    expect(useRunStore.getState().status).toBe('paused');
    jest.advanceTimersByTime(120_000);

    const run = await runSession.stop();
    runSession.reset();
    jest.useRealTimers();

    expect(run).not.toBeNull();
    // One minute of running, two minutes of pause: only the minute counts.
    expect(run?.metrics.elapsedMs).toBeGreaterThanOrEqual(55_000);
    expect(run?.metrics.elapsedMs).toBeLessThan(75_000);
  });
});
