/** The conversation closes itself so a forgotten session cannot drain the battery. */
export const SILENCE_TIMEOUT_MS = 30_000;
/** A talkative agent must not be able to hold the mic open forever. */
export const MAX_SESSION_MS = 5 * 60_000;
/** ElevenLabs' own speech probability; wind and footfall score well below this. */
export const SPEECH_PROBABILITY = 0.5;
/** A score older than this describes a runner who has already stopped talking. */
export const VAD_FRESHNESS_MS = 2_000;

export type SessionActivity = {
  now: number;
  startedAt: number;
  lastSpoke: number;
  agentSpeaking: boolean;
  /** Latest `onVadScore` value and when it arrived. */
  vadScore: number;
  vadAt: number;
};

/** A long uninterrupted answer only reaches `onMessage` once it ends, so the agent's
 * voice-activity score has to count as activity too, or the runner is cut off. */
export function runnerIsActive(activity: SessionActivity): boolean {
  if (activity.now - activity.vadAt > VAD_FRESHNESS_MS) return false;
  return activity.vadScore >= SPEECH_PROBABILITY;
}

export function shouldEndSession(activity: SessionActivity): boolean {
  if (activity.now - activity.startedAt > MAX_SESSION_MS) return true;
  if (activity.agentSpeaking || runnerIsActive(activity)) return false;
  return activity.now - activity.lastSpoke > SILENCE_TIMEOUT_MS;
}
