import { MAX_SESSION_MS, SILENCE_TIMEOUT_MS, shouldEndSession } from '../voice/idle';

const base = {
  now: 100_000,
  startedAt: 100_000,
  lastSpoke: 100_000,
  agentSpeaking: false,
  vadScore: 0,
  vadAt: 0,
};

describe('shouldEndSession', () => {
  it('keeps a silent-on-the-wire session open while the runner is still talking', () => {
    const now = base.now + SILENCE_TIMEOUT_MS + 5_000;
    expect(shouldEndSession({ ...base, now, vadScore: 0.9, vadAt: now })).toBe(false);
  });

  it('closes a session held open by wind and footfall alone', () => {
    const now = base.now + SILENCE_TIMEOUT_MS + 1;
    expect(shouldEndSession({ ...base, now, vadScore: 0.2, vadAt: now })).toBe(true);
  });

  it('ignores a speech score the runner has already stopped producing', () => {
    const now = base.now + SILENCE_TIMEOUT_MS + 10_000;
    expect(shouldEndSession({ ...base, now, vadScore: 0.9, vadAt: now - 10_000 })).toBe(true);
  });

  it('closes a session the runner has abandoned', () => {
    const now = base.now + SILENCE_TIMEOUT_MS + 1;
    expect(shouldEndSession({ ...base, now })).toBe(true);
  });

  it('does not let the runner talk past the hard session cap', () => {
    const now = base.now + MAX_SESSION_MS + 1;
    expect(shouldEndSession({ ...base, now, lastSpoke: now, vadScore: 0.9, vadAt: now })).toBe(true);
  });

  it('waits while the coach is mid-sentence', () => {
    const now = base.now + SILENCE_TIMEOUT_MS + 1;
    expect(shouldEndSession({ ...base, now, agentSpeaking: true })).toBe(false);
  });
});
