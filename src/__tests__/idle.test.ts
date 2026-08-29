import { MAX_SESSION_MS, SILENCE_TIMEOUT_MS, shouldEndSession } from '../voice/idle';

const base = {
  now: 100_000,
  startedAt: 100_000,
  lastSpoke: 100_000,
  agentSpeaking: false,
  inputLevel: 0,
};

describe('shouldEndSession', () => {
  it('keeps a silent-on-the-wire session open while the runner is still talking', () => {
    const now = base.now + SILENCE_TIMEOUT_MS + 5_000;
    expect(shouldEndSession({ ...base, now, inputLevel: 0.3 })).toBe(false);
  });

  it('closes a session the runner has abandoned', () => {
    const now = base.now + SILENCE_TIMEOUT_MS + 1;
    expect(shouldEndSession({ ...base, now })).toBe(true);
  });

  it('does not let the runner talk past the hard session cap', () => {
    const now = base.now + MAX_SESSION_MS + 1;
    expect(shouldEndSession({ ...base, now, lastSpoke: now, inputLevel: 0.9 })).toBe(true);
  });

  it('waits while the coach is mid-sentence', () => {
    const now = base.now + SILENCE_TIMEOUT_MS + 1;
    expect(shouldEndSession({ ...base, now, agentSpeaking: true })).toBe(false);
  });
});
