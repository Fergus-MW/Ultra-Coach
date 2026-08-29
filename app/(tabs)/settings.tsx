import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { allStaticPhrases } from '../../src/coach/cues';
import { zoneRangeBpm } from '../../src/metrics';
import { useSettings, voiceConfigFrom } from '../../src/store/settings';
import { colors, spacing, ZONE_COLORS } from '../../src/theme';
import type { ZoneNumber } from '../../src/types';
import { Button, Card, Field, Muted, Row, Screen } from '../../src/ui/components';
import { clearCache, listVoices, warmCache } from '../../src/voice/elevenlabs';

const ZONES: ZoneNumber[] = [1, 2, 3, 4, 5];

export default function SettingsScreen() {
  const { settings, apiKey, update, setApiKey, regeneratePlan } = useSettings();
  const [keyDraft, setKeyDraft] = useState(apiKey);
  const [warming, setWarming] = useState<string | null>(null);
  const [planDraft, setPlanDraft] = useState(settings.planConfig);

  const voice = voiceConfigFrom(settings, apiKey);

  const onWarm = async () => {
    if (!voice) {
      Alert.alert('Add your ElevenLabs API key first.');
      return;
    }
    const phrases = allStaticPhrases();
    setWarming(`0/${phrases.length}`);
    const result = await warmCache(phrases, voice, (done, total) => setWarming(`${done}/${total}`));
    setWarming(null);
    Alert.alert(
      'Voice cache',
      `${result.cached} cached, ${result.failed} failed.${result.errors.length ? `\n${result.errors[0]}` : ''}`,
    );
  };

  const onCheckKey = async () => {
    try {
      const voices = await listVoices(keyDraft);
      Alert.alert('ElevenLabs', `Key works. ${voices.length} voices available.`);
    } catch (error) {
      Alert.alert('ElevenLabs', (error as Error).message);
    }
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Card title="Voice">
          <Field label="ElevenLabs API key" value={keyDraft} onChangeText={setKeyDraft} secure placeholder="sk_..." />
          <Row>
            <Button label="Save key" onPress={() => void setApiKey(keyDraft.trim())} />
            <Button label="Test key" variant="secondary" onPress={() => void onCheckKey()} />
          </Row>
          <View style={styles.spacer} />
          <Field
            label="Voice id"
            value={settings.voiceId}
            onChangeText={(value) => void update({ voiceId: value })}
          />
          <Field
            label="Conversational agent id (push to talk)"
            value={settings.agentId}
            onChangeText={(value) => void update({ agentId: value })}
            placeholder="agent_..."
          />
          <Row>
            <Button
              label={warming ? `Caching ${warming}` : 'Pre-cache cues'}
              onPress={() => void onWarm()}
              disabled={warming !== null}
            />
            <Button
              label="Clear cache"
              variant="secondary"
              onPress={() => {
                clearCache();
                Alert.alert('Voice cache cleared.');
              }}
            />
          </Row>
          <Muted>
            Cues are rendered ahead of time so they play instantly and keep working with no signal. Live synthesis
            covers dynamic lines; the device voice is the last resort.
          </Muted>
          <Toggle
            label="Synthesise dynamic lines live"
            value={settings.allowLiveSynthesis}
            onChange={(value) => void update({ allowLiveSynthesis: value })}
          />
          <Toggle
            label="Fall back to device voice offline"
            value={settings.allowDeviceFallback}
            onChange={(value) => void update({ allowDeviceFallback: value })}
          />
        </Card>

        <Card title="Heart rate zones">
          <Row>
            <View style={styles.half}>
              <Field
                label="Max HR"
                keyboardType="numeric"
                value={String(settings.zones.maxHr)}
                onChangeText={(value) =>
                  void update({ zones: { ...settings.zones, maxHr: Number(value) || settings.zones.maxHr } })
                }
              />
            </View>
            <View style={styles.half}>
              <Field
                label="Resting HR"
                keyboardType="numeric"
                value={String(settings.zones.restingHr)}
                onChangeText={(value) =>
                  void update({ zones: { ...settings.zones, restingHr: Number(value) || settings.zones.restingHr } })
                }
              />
            </View>
          </Row>
          {ZONES.map((zone) => {
            const [low, high] = zoneRangeBpm(settings.zones, zone);
            return (
              <View key={zone} style={styles.zoneRow}>
                <Text style={[styles.zoneLabel, { color: ZONE_COLORS[zone] }]}>Zone {zone}</Text>
                <Text style={styles.zoneRange}>
                  {low}–{high} bpm
                </Text>
              </View>
            );
          })}
          <Muted>Zones use heart rate reserve (Karvonen), which holds up better on long climbs than %max.</Muted>
        </Card>

        <Card title="Coaching">
          <Toggle
            label="Distance splits"
            value={settings.coach.splitsEnabled}
            onChange={(value) => void update({ coach: { ...settings.coach, splitsEnabled: value } })}
          />
          <Toggle
            label="Fuel and drink reminders"
            value={settings.coach.fuellingEnabled}
            onChange={(value) => void update({ coach: { ...settings.coach, fuellingEnabled: value } })}
          />
          <Toggle
            label="Miles instead of kilometres"
            value={settings.coach.useMiles}
            onChange={(value) => void update({ coach: { ...settings.coach, useMiles: value } })}
          />
          <Row>
            <View style={styles.half}>
              <Field
                label="Fuel every (min)"
                keyboardType="numeric"
                value={String(Math.round(settings.coach.fuelIntervalMs / 60000))}
                onChangeText={(value) =>
                  void update({
                    coach: { ...settings.coach, fuelIntervalMs: (Number(value) || 30) * 60000 },
                  })
                }
              />
            </View>
            <View style={styles.half}>
              <Field
                label="Drink every (min)"
                keyboardType="numeric"
                value={String(Math.round(settings.coach.drinkIntervalMs / 60000))}
                onChangeText={(value) =>
                  void update({
                    coach: { ...settings.coach, drinkIntervalMs: (Number(value) || 20) * 60000 },
                  })
                }
              />
            </View>
          </Row>
        </Card>

        <Card title="Training plan">
          <Field
            label="Race name"
            value={planDraft.raceName}
            onChangeText={(value) => setPlanDraft({ ...planDraft, raceName: value })}
          />
          <Row>
            <View style={styles.half}>
              <Field
                label="Race date (YYYY-MM-DD)"
                value={planDraft.raceDateIso}
                onChangeText={(value) => setPlanDraft({ ...planDraft, raceDateIso: value })}
              />
            </View>
            <View style={styles.half}>
              <Field
                label="Distance (km)"
                keyboardType="numeric"
                value={String(planDraft.raceDistanceKm)}
                onChangeText={(value) =>
                  setPlanDraft({ ...planDraft, raceDistanceKm: Number(value) || planDraft.raceDistanceKm })
                }
              />
            </View>
          </Row>
          <Row>
            <View style={styles.half}>
              <Field
                label="Weekly minutes now"
                keyboardType="numeric"
                value={String(planDraft.currentWeeklyMin)}
                onChangeText={(value) =>
                  setPlanDraft({ ...planDraft, currentWeeklyMin: Number(value) || planDraft.currentWeeklyMin })
                }
              />
            </View>
            <View style={styles.half}>
              <Field
                label="Longest run (min)"
                keyboardType="numeric"
                value={String(planDraft.currentLongRunMin)}
                onChangeText={(value) =>
                  setPlanDraft({ ...planDraft, currentLongRunMin: Number(value) || planDraft.currentLongRunMin })
                }
              />
            </View>
          </Row>
          <Button label="Generate plan" onPress={() => void regeneratePlan(planDraft)} />
        </Card>

        <Card title="Sensors">
          <Toggle
            label="Use simulated heart rate and GPS"
            value={settings.useSimulators}
            onChange={(value) => void update({ useSimulators: value })}
          />
          <Muted>
            Live heart rate comes straight off the Bluetooth Heart Rate Service (0x180D). Cloud health APIs lag by
            minutes, which is useless mid-effort.
          </Muted>
        </Card>
      </ScrollView>
    </Screen>
  );
}

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <View style={styles.toggle}>
      <Text style={styles.toggleLabel}>{label}</Text>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: colors.accent, false: colors.border }} />
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: spacing.md,
  },
  spacer: {
    height: spacing.md,
  },
  half: {
    flex: 1,
  },
  toggle: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  toggleLabel: {
    color: colors.text,
    flex: 1,
    paddingRight: spacing.sm,
  },
  zoneRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 3,
  },
  zoneLabel: {
    fontWeight: '700',
  },
  zoneRange: {
    color: colors.text,
    fontVariant: ['tabular-nums'],
  },
});
