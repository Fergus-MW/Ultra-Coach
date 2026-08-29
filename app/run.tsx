import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { formatDuration, formatPace } from '../src/metrics';
import { runSession, useRunStore } from '../src/run/session';
import { useSettings } from '../src/store/settings';
import { colors, spacing, ZONE_COLORS } from '../src/theme';
import type { PlannedSession } from '../src/types';
import { Button, Card, Muted, Row, Screen, Stat } from '../src/ui/components';
import { useCoachConversation } from '../src/voice/agent';

function findSession(sessionId: string | undefined, sessions: PlannedSession[]): PlannedSession | null {
  if (!sessionId) return null;
  return sessions.find((session) => session.id === sessionId) ?? null;
}

export default function RunScreen() {
  const router = useRouter();
  const { sessionId } = useLocalSearchParams<{ sessionId?: string }>();
  const { settings, apiKey } = useSettings();
  const { status, metrics, target, segmentLabel, heartRate, cues, locationError, simulated } = useRunStore();
  const talk = useCoachConversation();
  const [effort, setEffort] = useState(0);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const planned = findSession(sessionId, settings.plan?.weeks.flatMap((week) => week.sessions) ?? []);
    void runSession.start(planned, settings, apiKey);
  }, [apiKey, sessionId, settings]);

  useEffect(() => {
    runSession.applySettings(settings, apiKey);
  }, [apiKey, settings]);

  const zoneColor = metrics.zone ? ZONE_COLORS[metrics.zone] : colors.textMuted;
  const stale = metrics.heartRateAgeMs !== null && metrics.heartRateAgeMs > 15_000;

  const onStop = async () => {
    talk.stop();
    await runSession.stop();
    runSession.reset();
    router.back();
  };

  const changeEffort = (delta: number) => {
    const next = Math.max(-30, Math.min(30, effort + delta));
    setEffort(next);
    runSession.setSimulatedEffort(next);
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <Card>
          <Text style={styles.sessionTitle}>{target?.label ?? 'Free run'}</Text>
          <Muted>
            {segmentLabel ? `${segmentLabel} · ` : ''}Target zone {target?.zone ?? 2}
            {target?.durationMin ? ` · ${target.durationMin} min` : ''}
          </Muted>
        </Card>

        <Card>
          <View style={styles.hero}>
            <Text style={[styles.heroValue, { color: zoneColor }]}>{metrics.heartRateBpm ?? '--'}</Text>
            <View>
              <Text style={styles.heroLabel}>bpm</Text>
              <Text style={[styles.heroZone, { color: zoneColor }]}>
                {metrics.zone ? `Zone ${metrics.zone}` : 'no zone'}
              </Text>
            </View>
          </View>
          <Muted>
            {heartRate.status === 'connected'
              ? `${heartRate.deviceName ?? 'Strap'} connected${stale ? ' · signal stale' : ''}`
              : (heartRate.message ?? heartRate.status)}
            {simulated ? ' · simulated' : ''}
          </Muted>
        </Card>

        <Card>
          <Row>
            <Stat label="Distance" value={`${(metrics.distanceM / 1000).toFixed(2)} km`} />
            <Stat label="Elapsed" value={formatDuration(metrics.elapsedMs)} />
          </Row>
          <View style={styles.gap} />
          <Row>
            <Stat label="Pace /km" value={formatPace(metrics.paceSecPerKm)} />
            <Stat label="Avg /km" value={formatPace(metrics.averagePaceSecPerKm)} />
          </Row>
          <View style={styles.gap} />
          <Row>
            <Stat label="Gradient" value={`${metrics.gradientPct.toFixed(1)}%`} />
            <Stat label="Climb" value={`${Math.round(metrics.elevationGainM)} m`} />
          </Row>
          {locationError ? <Muted>{locationError}</Muted> : null}
        </Card>

        <Card title="Talk to the coach">
          <Button
            label={
              talk.status === 'connected'
                ? talk.isSpeaking
                  ? 'Coach speaking · tap to end'
                  : 'Listening · tap to end'
                : talk.status === 'connecting'
                  ? 'Connecting...'
                  : 'Hold a conversation'
            }
            variant={talk.status === 'connected' ? 'danger' : 'secondary'}
            onPress={talk.toggle}
          />
          <Muted>
            {talk.error ??
              'Opens a short voice session with your live numbers as context. It closes itself after 30 seconds of quiet to save battery and keep music clean.'}
          </Muted>
        </Card>

        {simulated ? (
          <Card title="Simulator">
            <Row>
              <Button label="Ease off" variant="secondary" onPress={() => changeEffort(-8)} />
              <Button label="Push harder" variant="secondary" onPress={() => changeEffort(8)} />
            </Row>
            <Muted>Effort bias {effort > 0 ? `+${effort}` : effort} bpm</Muted>
          </Card>
        ) : null}

        <Card title="Cues">
          {cues.length === 0 ? (
            <Muted>Nothing said yet.</Muted>
          ) : (
            cues.slice(0, 12).map((cue, index) => (
              <Text key={`${cue.at}-${index}`} style={styles.cue}>
                {new Date(cue.at).toLocaleTimeString()} · {cue.text}
              </Text>
            ))
          )}
        </Card>

        <Row>
          {status === 'paused' ? (
            <Button label="Resume" onPress={() => runSession.resume()} />
          ) : (
            <Button label="Pause" variant="secondary" onPress={() => runSession.pause()} />
          )}
          <Button label="Finish" variant="danger" onPress={() => void onStop()} />
        </Row>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: spacing.md,
    paddingBottom: spacing.xl,
  },
  sessionTitle: {
    color: colors.text,
    fontSize: 20,
    fontWeight: '700',
  },
  hero: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  heroValue: {
    fontSize: 72,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
    lineHeight: 76,
  },
  heroLabel: {
    color: colors.textMuted,
    fontSize: 16,
  },
  heroZone: {
    fontSize: 16,
    fontWeight: '700',
  },
  gap: {
    height: spacing.md,
  },
  cue: {
    color: colors.textMuted,
    fontSize: 13,
    paddingVertical: 2,
  },
});
