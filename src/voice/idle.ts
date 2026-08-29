/** The conversation closes itself so a forgotten session cannot drain the battery. */
export const SILENCE_TIMEOUT_MS = 30_000;
/** A talkative agent must not be able to hold the mic open forever. */
export const MAX_SESSION_MS = 5 * 60_000;
/** Mic level that counts as the runner talking rather than wind and footfall. */
export const SPEECH_LEVEL = 0.05;

export type SessionActivity = {
  now: number;
  startedAt: number;
  lastSpoke: number;
  agentSpeaking: boolean;
  inputLevel: number;
};

/** A long uninterrupted answer only reaches `onMessage` once it ends, so the live
 * mic level has to count as activity too, or the runner is cut off mid-sentence. */
export function runnerIsActive(activity: SessionActivity): boolean {
  return activity.inputLevel >= SPEECH_LEVEL;
}

export function shouldEndSession(activity: SessionActivity): boolean {
  if (activity.now - activity.startedAt > MAX_SESSION_MS) return true;
  if (activity.agentSpeaking || runnerIsActive(activity)) return false;
  return activity.now - activity.lastSpoke > SILENCE_TIMEOUT_MS;
}
