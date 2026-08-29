import * as Linking from 'expo-linking';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  apiBase,
  connectWearable,
  demoCall,
  demoProducts,
  type Identity,
  type Scenario,
} from '../../src/coach/api';
import { useCoach } from '../../src/store/coach';
import { colors, spacing } from '../../src/theme';
import { Button, Card, Muted, Screen } from '../../src/ui/components';

const SCENARIOS: { scenario: Scenario; label: string }[] = [
  { scenario: 'checkin', label: 'Check in on me' },
  { scenario: 'races', label: 'Find me a race' },
  { scenario: 'products', label: 'Sort my fuelling' },
  { scenario: 'excuse', label: 'Call out my excuses' },
];

const KIT_NEED = 'electrolytes and fuelling for cramp on long runs';

export default function CoachTab() {
  const online = useCoach((state) => state.online);
  const who = useCoach((state) => state.who);
  const wearable = useCoach((state) => state.wearable);
  const error = useCoach((state) => state.error);
  const [busy, setBusy] = useState('');

  const run = async (key: string, work: (me: Identity) => Promise<void>) => {
    if (!who) return;
    setBusy(key);
    useCoach.getState().setError('');
    try {
      await work(who);
    } catch (cause) {
      useCoach.getState().setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy('');
    }
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.status}>
          <View style={[styles.dot, { backgroundColor: online ? colors.good : colors.warn }]} />
          <Text style={styles.statusText}>
            {apiBase
              ? online
                ? 'Coach can reach you'
                : 'Reconnecting'
              : 'No coaching backend in this build'}
          </Text>
        </View>

        <Card title="Between runs">
          <Muted>
            The coach rings you. Nothing to fill in, nothing to ask it — keep the app open and it will come to
            you.
          </Muted>
        </Card>

        <Card title="Or make it call you now">
          <View style={styles.grid}>
            {SCENARIOS.map((option) => (
              <Button
                key={option.scenario}
                label={option.label}
                variant="secondary"
                disabled={busy !== '' || !who}
                onPress={() => void run(option.scenario, (me) => demoCall(me, option.scenario))}
              />
            ))}
            <Button
              label="Read my watch back to me"
              variant="secondary"
              disabled={busy !== '' || !wearable?.connected}
              onPress={() => void run('body', (me) => demoCall(me, 'body'))}
            />
            <Button
              label="Show kit on screen"
              variant="secondary"
              disabled={busy !== '' || !who}
              onPress={() => void run('kit', (me) => demoProducts(me, KIT_NEED))}
            />
          </View>
        </Card>

        {wearable?.available ? (
          <Card title={wearable.connected ? 'Your watch feeds the coach' : 'Give it your data'}>
            {wearable.connected ? (
              <Muted>{wearable.summary || 'Waiting for the first sync.'}</Muted>
            ) : (
              <Button
                label="Connect my watch"
                disabled={busy !== '' || !who}
                onPress={() =>
                  void run('watch', async (me) => {
                    // The provider's own consent page, in the phone's browser: no
                    // provider credential ever reaches this app.
                    await Linking.openURL(await connectWearable(me));
                    await useCoach.getState().refreshWearable();
                  })
                }
              />
            )}
          </Card>
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: {
    padding: spacing.md,
  },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  statusText: {
    color: colors.textMuted,
    fontSize: 13,
  },
  grid: {
    gap: spacing.sm,
  },
  error: {
    color: colors.bad,
    fontSize: 13,
  },
});
