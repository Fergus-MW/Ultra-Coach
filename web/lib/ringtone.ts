/** Two-tone ring, synthesised so there is no audio asset to ship or cache. */
export class Ringtone {
  private context: AudioContext | null = null;
  private timer: number | null = null;

  start(): void {
    if (this.timer !== null) return;

    this.context = new AudioContext();
    const pulse = () => this.chirp();
    pulse();
    this.timer = window.setInterval(pulse, 3000);
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.context?.close();
    this.context = null;
  }

  private chirp(): void {
    const context = this.context;
    if (!context) return;

    [0, 0.4].forEach((offset) => {
      const start = context.currentTime + offset;
      const oscillator = context.createOscillator();
      const gain = context.createGain();

      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(offset ? 480 : 620, start);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.25, start + 0.02);
      gain.gain.linearRampToValueAtTime(0, start + 0.32);

      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.35);
    });
  }
}
