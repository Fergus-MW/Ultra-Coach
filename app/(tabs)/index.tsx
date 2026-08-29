import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { allStaticPhrases } from '../../src/coach/cues';
import { sessionDateIso, sessionForDate, upcomingSessions } from '../../src/coach/plan';
import { useRuns } from '../../src/store/runs';
import { useSettings, voiceConfigFrom } from '../../src/store/settings';
import { colors, spacing, ZONE_COLORS } from '../../src/theme';
import { Button, Card, Muted, Row, Screen } from '../../src/ui/components';
import { cacheSummary } from '../../src/voice/elevenlabs';

const todayIso = () => new Date().toISOString().slice(0, 10);

export default function TodayScreen() {
  const router = useRouter();
  const { settings, apiKey, update } = useSettings();
  const runs = useRuns((state) => state.runs);
  const plan = settings.plan;
  const today = todayIso();
  const session = plan ? sessionForDate(plan, settings.planStartDateIso, today) : null;
  const next = plan ? upcomingSessions(plan, settings.planStartDateIso, today, 3) : [];
  const voice = useMemo(() => voiceConfigFrom(settings, apiKey), [settings, apiKey]);
  const [cache, setCache] = useState(() => ({ cached: 0, total: allStaticPhrases().length }));

  // The cue cache is on disk, so it changes behind this screen's back whenever
  // Settings warms or clears it; re-read it every time the tab is focused.
  useFocusEffect(
    useCallback(() => {
      setCache(
        voice
          ? cacheSummary(allStaticPhrases(), voice)
          : { cached: 0, total: allStaticPhrases().length },
      );
    }, [voice]),
  );

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <Card title={session ? 'Today' : 'No session scheduled'}>
          {session ? (
            <>
              <Text style={styles.title}>{session.title}</Text>
              <Row>
                <Text style={[styles.zone, { color: ZONE_COLORS[session.targetZone] }]}>
                  Zone {session.targetZone}
                </Text>
                <Text style={styles.meta}>{session.durationMin} min</Text>
              </Row>
              <Muted>{session.notes}</Muted>
            </>
          ) : (
            <Muted>
              {plan
                ? 'Rest day. You can still head out for a free run.'
                : 'Generate a training plan in Settings, or run without one.'}
            </Muted>
          )}
          <View style={styles.actions}>
            <Button
              label={session ? 'Start session' : 'Start free run'}
              onPress={() =>
                router.push({ pathname: '/run', params: session ? { sessionId: session.id } : {} })
              }
            />
          </View>
        </Card>

        <Card title="Coming up">
          {next.length === 0 ? (
            <Muted>No upcoming sessions.</Muted>
          ) : (
            next.map((item) => (
              <View key={item.id} style={styles.listRow}>
                <Text style={styles.listDate}>{sessionDateIso(settings.planStartDateIso, item).slice(5)}</Text>
                <Text style={styles.listTitle} numberOfLines={1}>
                  {item.title}
                </Text>
                <Text style={[styles.listZone, { color: ZONE_COLORS[item.targetZone] }]}>Z{item.targetZone}</Text>
              </View>
            ))
          )}
        </Card>

        <Card title="Readiness">
          <View style={styles.readyRow}>
            <Muted>Voice cues cached</Muted>
            <Text style={styles.readyValue}>
              {cache.cached}/{cache.total}
            </Text>
          </View>
          <View style={styles.readyRow}>
            <Muted>ElevenLabs key</Muted>
            <Text style={[styles.readyValue, { color: apiKey ? colors.good : colors.warn }]}>
              {apiKey ? 'saved' : 'missing'}
            </Text>
          </View>
          <View style={styles.readyRow}>
            <Muted>Simulated sensors</Muted>
            <Switch
              value={settings.useSimulators}
              onValueChange={(value) => void update({ useSimulators: value })}
              trackColor={{ true: colors.accent, false: colors.border }}
            />
          </View>
          <Muted>
            Simulator mode replays a synthetic heart rate and route so you can test coaching without the strap.
          </Muted>
        </Card>

        <Card title="Recent runs">
          {runs.length === 0 ? (
            <Muted>Nothing logged yet.</Muted>
          ) : (
            runs.slice(0, 3).map((run) => (
              <View key={run.id} style={styles.listRow}>
                <Text style={styles.listDate}>{new Date(run.startedAt).toISOString().slice(5, 10)}</Text>
                <Text style={styles.listTitle} numberOfLines={1}>
                  {run.sessionTitle}
                </Text>
                <Text style={styles.listZone}>{(run.metrics.distanceM / 1000).toFixed(1)} km</Text>
              </View>
            ))
          )}
        </Card>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: spacing.md,
  },
  title: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '700',
    marginBottom: spacing.xs,
  },
  zone: {
    fontWeight: '700',
    fontSize: 14,
  },
  meta: {
    color: colors.textMuted,
    fontSize: 14,
  },
  actions: {
    marginTop: spacing.md,
    flexDirection: 'row',
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 6,
  },
  listDate: {
    color: colors.textMuted,
    width: 48,
    fontVariant: ['tabular-nums'],
  },
  listTitle: {
    color: colors.text,
    flex: 1,
  },
  listZone: {
    color: colors.textMuted,
    fontWeight: '600',
  },
  readyRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  readyValue: {
    color: colors.text,
    fontWeight: '600',
  },
});
