import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { formatDuration, formatPace } from '../../src/metrics';
import { useRuns } from '../../src/store/runs';
import { colors, spacing, ZONE_COLORS } from '../../src/theme';
import type { ZoneNumber } from '../../src/types';
import { Button, Card, Muted, Screen } from '../../src/ui/components';

const ZONES: ZoneNumber[] = [1, 2, 3, 4, 5];

export default function HistoryScreen() {
  const { runs, remove } = useRuns();
  const [expanded, setExpanded] = useState<string | null>(null);

  if (runs.length === 0) {
    return (
      <Screen>
        <ScrollView contentContainerStyle={styles.content}>
          <Card title="History">
            <Muted>Completed runs land here with their metrics and every cue the coach spoke.</Muted>
          </Card>
        </ScrollView>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        {runs.map((run) => {
          const open = expanded === run.id;
          const totalZoneMs = ZONES.reduce((sum, zone) => sum + (run.timeInZoneMs[zone] ?? 0), 0) || 1;
          return (
            <Card key={run.id}>
              <Pressable onPress={() => setExpanded(open ? null : run.id)}>
                <Text style={styles.title}>{run.sessionTitle}</Text>
                <Muted>{new Date(run.startedAt).toLocaleString()}</Muted>
                <View style={styles.stats}>
                  <Text style={styles.stat}>{(run.metrics.distanceM / 1000).toFixed(2)} km</Text>
                  <Text style={styles.stat}>{formatDuration(run.metrics.elapsedMs)}</Text>
                  <Text style={styles.stat}>{formatPace(run.metrics.averagePaceSecPerKm)}/km</Text>
                  <Text style={styles.stat}>
                    {run.metrics.heartRateAvgBpm === null ? '--' : Math.round(run.metrics.heartRateAvgBpm)}{' '}
                    bpm
                  </Text>
                </View>
                <View style={styles.bar}>
                  {ZONES.map((zone) => {
                    const share = (run.timeInZoneMs[zone] ?? 0) / totalZoneMs;
                    if (share <= 0) return null;
                    return (
                      <View
                        key={zone}
                        style={{ flex: share, backgroundColor: ZONE_COLORS[zone], height: 8 }}
                      />
                    );
                  })}
                </View>
              </Pressable>
              {open ? (
                <View style={styles.details}>
                  <Muted>
                    {`Climb ${Math.round(run.metrics.elevationGainM)} m · descent ${Math.round(
                      run.metrics.elevationLossM,
                    )} m · moving ${formatDuration(run.metrics.movingMs)}`}
                  </Muted>
                  {run.cues.map((cue, index) => (
                    <Text key={`${cue.at}-${index}`} style={styles.cue}>
                      {new Date(cue.at).toLocaleTimeString()} · {cue.text}
                    </Text>
                  ))}
                  <View style={styles.actions}>
                    <Button label="Delete run" variant="danger" onPress={() => void remove(run.id)} />
                  </View>
                </View>
              ) : null}
            </Card>
          );
        })}
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
    fontSize: 18,
    fontWeight: '700',
  },
  stats: {
    flexDirection: 'row',
    gap: spacing.md,
    marginVertical: spacing.sm,
    flexWrap: 'wrap',
  },
  stat: {
    color: colors.text,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  bar: {
    flexDirection: 'row',
    borderRadius: 4,
    overflow: 'hidden',
    backgroundColor: colors.surfaceAlt,
  },
  details: {
    marginTop: spacing.sm,
    gap: 4,
  },
  cue: {
    color: colors.textMuted,
    fontSize: 12,
  },
  actions: {
    marginTop: spacing.sm,
    flexDirection: 'row',
  },
});
