export type CueId =
  | 'run_start'
  | 'zone_high'
  | 'zone_low'
  | 'zone_back'
  | 'hill_hike'
  | 'descent'
  | 'cardiac_drift'
  | 'fuel'
  | 'drink'
  | 'split'
  | 'halfway'
  | 'segment_change'
  | 'target_reached'
  | 'hr_lost'
  | 'hr_restored'
  | 'run_end';

export interface Cue {
  id: CueId;
  text: string;
  /** Higher wins when two cues want the ear at the same moment. */
  priority: number;
  /** Non-interruptible cues finish even if a higher priority cue arrives. */
  interruptible: boolean;
  /** Dynamic cues contain run-specific numbers, so they cannot be pre-rendered. */
  dynamic: boolean;
}

/**
 * Static lines are pre-rendered to audio before a run so a threshold crossing
 * speaks immediately rather than waiting on the network. Multiple variants per
 * cue stop three hours of coaching sounding like a fire alarm.
 */
export const STATIC_CUE_VARIANTS: Record<string, string[]> = {
  run_start: ['Off we go. Settle in and find the rhythm.', 'Running. Ease into it.'],
  zone_high: [
    'Effort is high. Back it off and let the heart rate come down.',
    'Too hot. Shorten the stride and breathe.',
    'Ease off. This is faster than the plan wants.',
  ],
  zone_low: [
    'You have drifted easy. Lift the effort a little.',
    'Pick it up. A touch more purpose.',
  ],
  zone_back: ['Good. That is the zone. Hold it.', 'Back on target. Stay there.'],
  hill_hike: [
    'Steep. Hike this one, hands on the quads, save the legs.',
    'Power hike here. You lose nothing and keep the heart rate down.',
  ],
  descent: [
    'Downhill. Let the legs turn over, stay light and relaxed.',
    'Free speed. Quick feet, soft landing.',
  ],
  cardiac_drift: [
    'Heart rate is drifting at the same pace. Take on fluid and a gel.',
    'Drift is showing. Fuel now and give it ten minutes.',
  ],
  fuel: ['Fuel now.', 'Time to eat. Do it while it is easy.'],
  drink: ['Drink.', 'Take a few sips.'],
  hr_lost: ['Lost the heart rate signal. Coaching on pace alone.'],
  hr_restored: ['Heart rate is back.'],
  target_reached: ['That is the session. Everything from here is a bonus.'],
  run_end: ['Session done. Walk it out and eat something in the next half hour.'],
};

export function staticCueText(id: CueId, rotation: number): string {
  const variants = STATIC_CUE_VARIANTS[id];
  if (!variants || variants.length === 0) return '';
  return variants[rotation % variants.length];
}

/** Every phrase that should exist as cached audio before a run starts. */
export function allStaticPhrases(): string[] {
  return Object.values(STATIC_CUE_VARIANTS).flat();
}

export function distanceLabel(distanceM: number, useMiles: boolean): string {
  if (useMiles) {
    const miles = distanceM / 1609.344;
    return `${miles.toFixed(miles < 10 ? 1 : 0)} miles`;
  }
  const km = distanceM / 1000;
  return `${km.toFixed(km < 10 ? 1 : 0)} kilometres`;
}

export function paceLabel(secPerKm: number, useMiles: boolean): string {
  const perUnit = useMiles ? secPerKm * 1.609344 : secPerKm;
  const minutes = Math.floor(perUnit / 60);
  const seconds = Math.round(perUnit % 60);
  const unit = useMiles ? 'per mile' : 'per kilometre';
  if (seconds === 0) return `${minutes} minutes ${unit}`;
  return `${minutes} ${seconds} ${unit}`;
}

export function durationLabel(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} minutes`;
  if (minutes === 0) return hours === 1 ? 'one hour' : `${hours} hours`;
  return `${hours} ${hours === 1 ? 'hour' : 'hours'} ${minutes}`;
}
