import { useConversation } from '@elevenlabs/react-native';
import { AudioModule } from 'expo-audio';
import { useCallback, useEffect, useRef, useState } from 'react';
import { runSession } from '../run/session';
import { useSettings } from '../store/settings';
import { getConversationToken } from './elevenlabs';

/** Biometrics go in as contextual updates, never by rewriting instructions. */
const CONTEXT_INTERVAL_MS = 30_000;
/** The conversation closes itself so a forgotten session cannot drain the battery. */
const SILENCE_TIMEOUT_MS = 30_000;

export type TalkStatus = 'idle' | 'connecting' | 'connected' | 'error';

export function useCoachConversation() {
  const settings = useSettings((state) => state.settings);
  const apiKey = useSettings((state) => state.apiKey);
  const [status, setStatus] = useState<TalkStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const lastActivity = useRef<number>(0);
  const contextTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const silenceTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimers = useCallback(() => {
    if (contextTimer.current) clearInterval(contextTimer.current);
    if (silenceTimer.current) clearInterval(silenceTimer.current);
    contextTimer.current = null;
    silenceTimer.current = null;
  }, []);

  const conversationRef = useRef<ReturnType<typeof useConversation> | null>(null);
  const stopRef = useRef<() => void>(() => {});

  const conversation = useConversation({
    onConnect: () => {
      setStatus('connected');
      lastActivity.current = Date.now();
      // startSession returns before the WebRTC connection exists, so the timers
      // can only be armed here, once there is a session to talk to.
      clearTimers();
      contextTimer.current = setInterval(() => {
        conversationRef.current?.sendContextualUpdate(runSession.contextSummary());
      }, CONTEXT_INTERVAL_MS);
      silenceTimer.current = setInterval(() => {
        if (Date.now() - lastActivity.current > SILENCE_TIMEOUT_MS) stopRef.current();
      }, 5000);
    },
    onDisconnect: () => {
      clearTimers();
      setStatus('idle');
      runSession.setVoiceSuppressed(false);
    },
    onMessage: () => {
      lastActivity.current = Date.now();
    },
    onError: (message: string) => {
      clearTimers();
      setError(message);
      setStatus('error');
      runSession.setVoiceSuppressed(false);
    },
  });

  const stop = useCallback(() => {
    clearTimers();
    conversation.endSession();
    runSession.setVoiceSuppressed(false);
    setStatus('idle');
  }, [clearTimers, conversation]);

  const start = useCallback(async () => {
    if (!settings.agentId) {
      setError('Add an ElevenLabs agent id in Settings first.');
      setStatus('error');
      return;
    }
    setError(null);
    setStatus('connecting');
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) throw new Error('Microphone permission denied.');

      // Suppress cues first: opening the mic is the one moment the rules engine
      // must not talk over the conversation.
      runSession.setVoiceSuppressed(true);

      // React Native only supports WebRTC: a private agent needs a conversation
      // token, a public one connects on its id alone.
      const config = apiKey
        ? { conversationToken: await getConversationToken(apiKey, settings.agentId) }
        : { agentId: settings.agentId };

      conversation.startSession({
        ...config,
        connectionType: 'webrtc' as const,
        dynamicVariables: {
          run_context: runSession.contextSummary(),
        },
      });
    } catch (caught) {
      clearTimers();
      setError((caught as Error).message);
      setStatus('error');
      runSession.setVoiceSuppressed(false);
    }
  }, [apiKey, clearTimers, conversation, settings.agentId]);

  useEffect(() => {
    conversationRef.current = conversation;
    stopRef.current = stop;
  });

  useEffect(() => clearTimers, [clearTimers]);

  return {
    status,
    error,
    isSpeaking: conversation.isSpeaking,
    start,
    stop,
    toggle: () => (status === 'connected' || status === 'connecting' ? stop() : void start()),
  };
}
