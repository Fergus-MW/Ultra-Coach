import type { WearablePanel } from '@/lib/runner';
import styles from './watch.module.css';

type Tile = { label: string; value: string; note: string };

/**
 * The watch as the runner sees it, alongside the same numbers the coach is reading.
 * Only what the device actually sent is shown: an empty tile invites an argument about
 * whether the sync worked.
 */
export default function Watch({ panel }: { panel: WearablePanel }) {
  const tiles = toTiles(panel);
  if (!tiles.length) {
    return <p className={styles.empty}>Waiting for the first sync.</p>;
  }

  return (
    <>
      <div className={styles.grid}>
        {tiles.map((tile) => (
          <div className={styles.tile} key={tile.label}>
            <span className={styles.label}>{tile.label}</span>
            <span className={styles.value}>{tile.value}</span>
            <span className={styles.note}>{tile.note}</span>
          </div>
        ))}
      </div>
      {panel.provider && <p className={styles.source}>Straight off {panel.provider}</p>}
    </>
  );
}

function toTiles(panel: WearablePanel): Tile[] {
  const tiles: Tile[] = [];
  const { daily, sleep, activity } = panel;

  if (daily) {
    const when = day(daily.at);
    if (daily.steps) tiles.push({ label: 'Steps', value: daily.steps.toLocaleString(), note: when });
    if (daily.resting_bpm)
      tiles.push({ label: 'Resting HR', value: `${round(daily.resting_bpm)} bpm`, note: when });
    if (daily.active_minutes)
      tiles.push({ label: 'Active', value: `${round(daily.active_minutes)} min`, note: when });
  }

  if (sleep) {
    const when = `night of ${day(sleep.at)}`;
    if (sleep.asleep_minutes)
      tiles.push({ label: 'Asleep', value: hours(sleep.asleep_minutes), note: when });
    if (sleep.efficiency_percent)
      tiles.push({
        label: 'Sleep quality',
        value: `${round(sleep.efficiency_percent)}%`,
        note: when,
      });
    if (sleep.hrv_ms) tiles.push({ label: 'HRV', value: `${round(sleep.hrv_ms)} ms`, note: when });
  }

  if (activity) {
    const when = `${activity.name ?? 'Session'} · ${day(activity.at)}`;
    if (activity.km) tiles.push({ label: 'Last run', value: `${activity.km.toFixed(1)} km`, note: when });
    if (activity.pace_per_km)
      tiles.push({ label: 'Pace', value: `${activity.pace_per_km} /km`, note: when });
    if (activity.avg_bpm)
      tiles.push({ label: 'Run HR', value: `${round(activity.avg_bpm)} bpm`, note: when });
  }

  return tiles;
}

/** Dates a runner recognises: they know when they ran, not which ISO day it was. */
function day(at: string): string {
  const moment = new Date(at);
  if (Number.isNaN(moment.getTime())) return '';
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const days = Math.floor((midnight.getTime() - moment.getTime()) / 86_400_000) + 1;
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return moment.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function hours(minutes: number): string {
  const whole = Math.round(minutes);
  if (whole < 60) return `${whole}m`;
  return `${Math.floor(whole / 60)}h ${String(whole % 60).padStart(2, '0')}m`;
}

function round(value: number): string {
  return Math.round(value).toLocaleString();
}
