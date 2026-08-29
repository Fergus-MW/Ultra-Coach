import { useRouter } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { sessionDateIso } from '../../src/coach/plan';
import { useSettings } from '../../src/store/settings';
import { colors, spacing, ZONE_COLORS } from '../../src/theme';
import { Button, Card, Muted, Screen } from '../../src/ui/components';

export default function PlanScreen() {
  const router = useRouter();
  const settings = useSettings((state) => state.settings);
  const plan = settings.plan;

  if (!plan) {
    return (
      <Screen>
        <ScrollView contentContainerStyle={styles.content}>
          <Card title="No plan yet">
            <Muted>Set your race and current volume in Settings to build a progressive plan.</Muted>
            <View style={styles.actions}>
              <Button label="Open settings" onPress={() => router.push('/settings')} />
            </View>
          </Card>
        </ScrollView>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <Card title="Race">
          <Text style={styles.title}>{plan.raceName}</Text>
          <Muted>
            {plan.raceDistanceKm} km on {plan.raceDateIso} · {plan.weeks.length} weeks
          </Muted>
        </Card>
        {plan.weeks.map((week) => (
          <Card key={week.index} title={`Week ${week.index + 1} · ${week.phase}${week.isDownWeek ? ' · down' : ''}`}>
            <Muted>{Math.round(week.volumeMin / 6) / 10} hours planned</Muted>
            {week.sessions.map((session) => (
              <View key={session.id} style={styles.row}>
                <Text style={styles.date}>{sessionDateIso(settings.planStartDateIso, session).slice(5)}</Text>
                <View style={styles.rowMain}>
                  <Text style={styles.sessionTitle} numberOfLines={1}>
                    {session.title}
                  </Text>
                  <Text style={styles.notes} numberOfLines={1}>
                    {session.notes}
                  </Text>
                </View>
                <Text style={[styles.zone, { color: ZONE_COLORS[session.targetZone] }]}>Z{session.targetZone}</Text>
                <Text style={styles.duration}>{session.durationMin}′</Text>
              </View>
            ))}
          </Card>
        ))}
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
    fontSize: 20,
    fontWeight: '700',
  },
  actions: {
    marginTop: spacing.md,
    flexDirection: 'row',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  rowMain: {
    flex: 1,
  },
  date: {
    color: colors.textMuted,
    width: 44,
    fontVariant: ['tabular-nums'],
  },
  sessionTitle: {
    color: colors.text,
    fontWeight: '600',
  },
  notes: {
    color: colors.textMuted,
    fontSize: 12,
  },
  zone: {
    fontWeight: '700',
  },
  duration: {
    color: colors.textMuted,
    width: 42,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
});
