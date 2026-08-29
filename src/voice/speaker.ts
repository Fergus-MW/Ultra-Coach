import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import * as Speech from 'expo-speech';
import type { Cue } from '../coach/cues';
import { cachedPhraseUri, synthesizeToCache, type VoiceConfig } from './elevenlabs';

export interface SpeakerOptions {
  voice: VoiceConfig | null;
  /** Allow a network round trip for lines that were never pre-rendered. */
  allowLiveSynthesis: boolean;
  /** Fall back to the device voice when there is no cached audio. */
  allowDeviceFallback: boolean;
  volume: number;
}

export const DEFAULT_SPEAKER_OPTIONS: SpeakerOptions = {
  voice: null,
  allowLiveSynthesis: true,
  allowDeviceFallback: true,
  volume: 1,
};

const MAX_QUEUE = 2;

export type SpokenListener = (cue: Cue) => void;

/**
 * Owns the ear. Plays pre-rendered ElevenLabs audio when it exists, falls back
 * to the device voice when it does not, and never lets a low priority line
 * talk over a warning.
 */
export class Speaker {
  private options: SpeakerOptions = DEFAULT_SPEAKER_OPTIONS;
  private queue: Cue[] = [];
  private current: Cue | null = null;
  private player: AudioPlayer | null = null;
  private listeners = new Set<SpokenListener>();
  private audioConfigured = false;
  private suppressed = false;

  setOptions(options: SpeakerOptions): void {
    this.options = options;
  }

  onSpoken(listener: SpokenListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get speaking(): boolean {
    return this.current !== null;
  }

  private async configureAudio(): Promise<void> {
    if (this.audioConfigured) return;
    this.audioConfigured = true;
    // Ducking rather than exclusive focus: music drops for the cue and comes
    // straight back, which is what you want three hours into a run.
    await setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'duckOthers',
      allowsRecording: false,
    }).catch(() => undefined);
  }

  /** Silences cues while the conversational agent owns the microphone. */
  setSuppressed(suppressed: boolean): void {
    this.suppressed = suppressed;
    if (suppressed) this.stop();
  }

  enqueue(cue: Cue): void {
    if (this.suppressed) return;
    if (this.current) {
      if (this.current.interruptible && cue.priority > this.current.priority) {
        this.stopCurrent();
      } else {
        this.queue.push(cue);
        this.queue.sort((a, b) => b.priority - a.priority);
        this.queue = this.queue.slice(0, MAX_QUEUE);
        return;
      }
    }
    void this.play(cue);
  }

  private stopCurrent(): void {
    Speech.stop();
    if (this.player) {
      try {
        this.player.remove();
      } catch {
        // Player already released.
      }
      this.player = null;
    }
    this.current = null;
  }

  private drain(): void {
    const next = this.queue.shift();
    if (next) void this.play(next);
  }

  private async play(cue: Cue): Promise<void> {
    this.current = cue;
    await this.configureAudio();
    const uri = await this.resolveAudio(cue);
    if (uri) {
      try {
        await this.playFile(uri);
        this.finish(cue);
        return;
      } catch {
        // Fall through to the device voice.
      }
    }
    if (this.options.allowDeviceFallback) {
      await this.speakOnDevice(cue.text);
    }
    this.finish(cue);
  }

  private finish(cue: Cue): void {
    this.current = null;
    this.player = null;
    this.listeners.forEach((listener) => listener(cue));
    this.drain();
  }

  private async resolveAudio(cue: Cue): Promise<string | null> {
    const voice = this.options.voice;
    if (!voice?.apiKey) return null;
    const cached = cachedPhraseUri(cue.text, voice);
    if (cached) return cached;
    if (cue.dynamic && !this.options.allowLiveSynthesis) return null;
    if (!this.options.allowLiveSynthesis) return null;
    try {
      return await synthesizeToCache(cue.text, voice);
    } catch {
      return null;
    }
  }

  private playFile(uri: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let player: AudioPlayer;
      try {
        player = createAudioPlayer({ uri });
      } catch (error) {
        reject(error as Error);
        return;
      }
      this.player = player;
      player.volume = this.options.volume;
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        subscription.remove();
        try {
          player.remove();
        } catch {
          // Already released.
        }
        resolve();
      };
      const subscription = player.addListener('playbackStatusUpdate', (status) => {
        if (status.didJustFinish) done();
      });
      player.play();
      // Safety net: never wedge the queue if the player stops reporting.
      setTimeout(done, 30_000);
    });
  }

  private speakOnDevice(text: string): Promise<void> {
    return new Promise((resolve) => {
      Speech.speak(text, {
        rate: 1.0,
        onDone: () => resolve(),
        onStopped: () => resolve(),
        onError: () => resolve(),
      });
    });
  }

  stop(): void {
    this.queue = [];
    this.stopCurrent();
  }
}
