import { useConversation } from '@elevenlabs/react-native';
import { AudioModule } from 'expo-audio';
import { useCallback, useEffect, useRef } from 'react';
import { Modal, Pressable, StyleSheet, Text, Vibration, View } from 'react-native';
import { requestSession } from '../coach/api';
import { useCoach } from '../store/coach';
import { colors, radius, spacing } from '../theme';

/** Ring, pause, ring — a phone call, not a notification buzz. */
const RING_PATTERN = [0, 800, 1200];

/**
 * The coach's call, over whatever the runner was doing. It is the only route into a
 * conversation: there is no button that starts one, because the coach drives.
 */
export function CallOverlay() {
  const phase = useCoach((state) => state.phase);
  const incoming = useCoach((state) => state.incoming);
  const error = useCoach((state) => state.error);
  const who = useCoach((state) => state.who);

  const conversation = useConversation({
    onConnect: () => useCoach.getState().answered(),
    onDisconnect: () => useCoach.setState((state) => (state.phase === 'live' ? { phase: 'ended' } : {})),
    onError: (message: string) => useCoach.setState({ error: message, phase: 'ended' }),
  });

  const conversationRef = useRef(conversation);
  useEffect(() => {
    conversationRef.current = conversation;
  });

  useEffect(() => {
    // The store cancels calls from the socket, where there is no hook to end them with.
    useCoach.setState({ endSession: () => conversationRef.current.endSession() });
  }, []);

  useEffect(() => {
    if (phase !== 'ringing') return;
    Vibration.vibrate(RING_PATTERN, true);
    return () => Vibration.cancel();
  }, [phase]);

  const answer = useCallback(async () => {
    const coach = useCoach.getState();
    coach.setError('');
    coach.setPhase('connecting');
    try {
      if (!who) throw new Error('no runner identity yet');
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) throw new Error('Microphone permission denied.');

      const grant = await requestSession(who);
      conversation.startSession({
        conversationToken: grant.conversation_token,
        connectionType: 'webrtc' as const,
        // The agent's prompt reads {{runner_state}}; the webhook only writes a call into
        // a runner's history when the id it carries is signed, so both travel with the
        // session rather than being overridable from the phone.
        dynamicVariables: {
          runner_id: who.userId,
          runner_sig: grant.runner_sig,
          runner_state: grant.runner_state,
        },
        overrides: incoming?.openingLine ? { agent: { firstMessage: incoming.openingLine } } : undefined,
      });
    } catch (cause) {
      useCoach.setState({
        error: cause instanceof Error ? cause.message : String(cause),
        phase: 'ended',
      });
    }
  }, [conversation, incoming, who]);

  const speaking = conversation.isSpeaking;

  return (
    <Modal visible={phase !== 'standby'} animationType="slide" statusBarTranslucent>
      <View style={styles.screen}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>UC</Text>
        </View>

        {phase === 'ringing' && (
          <>
            <Text style={styles.caller}>Ultra Coach</Text>
            <Text style={styles.reason}>{incoming?.reason || 'Incoming call'}</Text>
            <View style={styles.actions}>
              <Action label="Decline" tone="bad" onPress={() => useCoach.getState().decline()} />
              <Action label="Answer" tone="good" onPress={() => void answer()} />
            </View>
          </>
        )}

        {phase === 'connecting' && <Text style={styles.reason}>Connecting…</Text>}

        {phase === 'live' && (
          <>
            <Text style={styles.caller}>{speaking ? 'Coach is talking' : 'Go on, answer'}</Text>
            <View style={styles.actions}>
              <Action
                label={conversation.isMuted ? 'Unmute' : 'Mute'}
                tone="mute"
                onPress={() => conversation.setMuted(!conversation.isMuted)}
              />
              <Action label="Hang up" tone="bad" onPress={() => useCoach.getState().hangUp()} />
            </View>
          </>
        )}

        {phase === 'ended' && (
          <>
            <Text style={styles.caller}>Call ended</Text>
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <View style={styles.actions}>
              <Action
                label="Back to standby"
                tone="good"
                onPress={() => useCoach.getState().setPhase('standby')}
              />
            </View>
          </>
        )}
      </View>
    </Modal>
  );
}

function Action({
  label,
  tone,
  onPress,
}: {
  label: string;
  tone: 'good' | 'bad' | 'mute';
  onPress: () => void;
}) {
  const background = tone === 'good' ? colors.good : tone === 'bad' ? colors.bad : colors.surfaceAlt;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.action, { backgroundColor: background, opacity: pressed ? 0.8 : 1 }]}
    >
      <Text style={styles.actionLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
    gap: spacing.md,
  },
  avatar: {
    width: 128,
    height: 128,
    borderRadius: 64,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: colors.text,
    fontSize: 40,
    fontWeight: '800',
  },
  caller: {
    color: colors.text,
    fontSize: 26,
    fontWeight: '700',
    textAlign: 'center',
  },
  reason: {
    color: colors.textMuted,
    fontSize: 16,
    textAlign: 'center',
  },
  error: {
    color: colors.bad,
    fontSize: 14,
    textAlign: 'center',
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.lg,
  },
  action: {
    borderRadius: radius.lg,
    paddingVertical: 16,
    paddingHorizontal: spacing.xl,
  },
  actionLabel: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
});
