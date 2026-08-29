/**
 * Two-tone ring, synthesised so there is no audio asset to ship or cache.
 *
 * A call arrives from a WebSocket, never from a tap, so an `AudioContext` created at that
 * moment would be suspended by autoplay policy and the runner would never hear the phone.
 * One shared context is therefore created and resumed from the first gesture on the page
 * (`unlockAudio`), long before the coach calls.
 */
let shared: AudioContext | null = null;

function context(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;

  shared ??= new Ctor();
  return shared;
}

/** Call from a user gesture. Resolves to whether the ring will actually be audible. */
export async function unlockAudio(): Promise<boolean> {
  const audio = context();
  if (!audio) return false;

  if (audio.state === "suspended") {
    try {
      await audio.resume();
    } catch {
      return false;
    }
  }
  return audio.state === "running";
}

export function audioReady(): boolean {
  return shared?.state === "running";
}

export class Ringtone {
  private timer: number | null = null;

  start(): void {
    if (this.timer !== null) return;

    // Resuming here covers the case where the browser allowed it without a gesture;
    // where it does not, the tap on the standby screen already did the work.
    void context()?.resume().catch(() => undefined);

    const pulse = () => this.chirp();
    pulse();
    this.timer = window.setInterval(pulse, 3000);
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  private chirp(): void {
    const audio = context();
    if (!audio || audio.state !== "running") return;

    [0, 0.4].forEach((offset) => {
      const start = audio.currentTime + offset;
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();

      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(offset ? 480 : 620, start);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.25, start + 0.02);
      gain.gain.linearRampToValueAtTime(0, start + 0.32);

      oscillator.connect(gain).connect(audio.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.35);
    });
  }
}
