import { Directory, File, Paths } from 'expo-file-system';

export const ELEVENLABS_API = 'https://api.elevenlabs.io/v1';
export const DEFAULT_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb';
export const DEFAULT_MODEL_ID = 'eleven_flash_v2_5';

export interface VoiceConfig {
  apiKey: string;
  voiceId: string;
  modelId: string;
}

/** Stable filename for a phrase so the cache survives app restarts. */
export function phraseKey(text: string, voiceId: string, modelId: string): string {
  const input = `${voiceId}|${modelId}|${text}`;
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
  }
  return `cue-${hash.toString(36)}.mp3`;
}

function cacheDirectory(): Directory {
  const directory = new Directory(Paths.cache, 'cues');
  if (!directory.exists) directory.create({ intermediates: true });
  return directory;
}

export function cachedPhraseUri(text: string, config: VoiceConfig): string | null {
  const file = new File(cacheDirectory(), phraseKey(text, config.voiceId, config.modelId));
  return file.exists ? file.uri : null;
}

export async function synthesizeToCache(text: string, config: VoiceConfig): Promise<string> {
  const file = new File(cacheDirectory(), phraseKey(text, config.voiceId, config.modelId));
  if (file.exists) return file.uri;

  const response = await fetch(
    `${ELEVENLABS_API}/text-to-speech/${config.voiceId}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': config.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: config.modelId,
        voice_settings: { stability: 0.4, similarity_boost: 0.75, speed: 1.05 },
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`ElevenLabs ${response.status}: ${await response.text()}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  file.create({ overwrite: true });
  file.write(bytes);
  return file.uri;
}

export interface WarmResult {
  cached: number;
  failed: number;
  errors: string[];
}

/**
 * Renders every static cue to disk while the network is good, so a threshold
 * crossing on a hillside plays instantly and works with no signal at all.
 */
export async function warmCache(
  phrases: string[],
  config: VoiceConfig,
  onProgress?: (done: number, total: number) => void,
): Promise<WarmResult> {
  const result: WarmResult = { cached: 0, failed: 0, errors: [] };
  let done = 0;
  for (const phrase of phrases) {
    try {
      await synthesizeToCache(phrase, config);
      result.cached += 1;
    } catch (error) {
      result.failed += 1;
      const message = (error as Error).message;
      if (!result.errors.includes(message)) result.errors.push(message);
    }
    done += 1;
    onProgress?.(done, phrases.length);
  }
  return result;
}

export function clearCache(): void {
  const directory = cacheDirectory();
  if (directory.exists) directory.delete();
}

export function cacheSummary(phrases: string[], config: VoiceConfig): { cached: number; total: number } {
  const cached = phrases.filter((phrase) => cachedPhraseUri(phrase, config) !== null).length;
  return { cached, total: phrases.length };
}

export interface ElevenLabsVoice {
  voice_id: string;
  name: string;
}

export async function listVoices(apiKey: string): Promise<ElevenLabsVoice[]> {
  const response = await fetch(`${ELEVENLABS_API}/voices`, { headers: { 'xi-api-key': apiKey } });
  if (!response.ok) throw new Error(`ElevenLabs ${response.status}: ${await response.text()}`);
  const body = (await response.json()) as { voices: ElevenLabsVoice[] };
  return body.voices ?? [];
}

/**
 * Private agents need a short-lived token. React Native only speaks WebRTC, so
 * this is the token endpoint rather than the WebSocket signed URL.
 */
export async function getConversationToken(apiKey: string, agentId: string): Promise<string> {
  const response = await fetch(
    `${ELEVENLABS_API}/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`,
    { headers: { 'xi-api-key': apiKey } },
  );
  if (!response.ok) throw new Error(`ElevenLabs ${response.status}: ${await response.text()}`);
  const body = (await response.json()) as { token: string };
  return body.token;
}
